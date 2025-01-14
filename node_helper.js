const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, ".env") });
const fs = require("fs");
const NodeHelper = require("node_helper");
const moment = require("moment");
const Dropbox = require("dropbox").Dropbox;
const fetch = require("node-fetch");

const IMG_FOLDER = path.join(__dirname, "image_cache");
const ERR_MESSAGE = "The Dropbox folder you chose doesn't exist or is empty. Please try a different one.";

module.exports = NodeHelper.create({

	start () {

		console.log(`Starting node_helper for module [${this.name}]`);

		// eslint-disable-next-line import/extensions
		this.credentials = require("./credentials.json");
		this.config = {};
		this.files = []; // use to store all available files we've pulled

	},

	initialize (config) {

		const dropBoxConfig = {
			fetch,
			accessToken: this.credentials.access_token,
			refreshToken: this.credentials.refresh_token,
			clientId: process.env.DROPBOX_APP_KEY,
			clientSecret: process.env.DROPBOX_APP_SECRET
		};

		this.config = config;
		this.extensions = [".jpg", ".jpeg", ".png", ".gif"];
		this.dbx = new Dropbox(dropBoxConfig);
		this.initialLoadDone = false; // triggered after the initial load of data
		this.filesToSave = 25;

		// see if image folder exists, otherwise create it
		if (!fs.existsSync(IMG_FOLDER)) {
			fs.mkdirSync(IMG_FOLDER);
		}

	},

	getData () {
		// get data from dropbox

		if (this.timer) {
			clearTimeout(this.timer);
		}

		if (this.dataTimer) {
			clearTimeout(this.dataTimer);
		}

		const self = this;

		this.files = [];

		const resultsMaxPerExtension = 200; // number of results per file extension
		const resultsMax = 200; // number of new results we want total
		const extLength = this.extensions.length; // how many file extensions to search for

		let extSearched = 0; // how many file extensions we've searched
		let stopAdding = false; // we've either found resultsMax or reached the end of our search results
		let filesAdded = 0; // how many new files we've added to this.files

		// if the path isn't empty, it needs to start with a `/`
		let path = this.config.folder ? this.config.folder.toLowerCase().trim() : "";
		if (path !== "") {
			if (path.charAt(0) !== "/") {
				path = `/${path}`;
			}
		}

		const fileSearch = (path, ext, start) => {
			self.dbx.filesSearch({
				path,
				query: ext,
				start,
				max_results: resultsMaxPerExtension,
				mode: "filename"
			}).then((result) => {

				const matches = result.result.matches;
				if ((matches) && (matches.length > 0)) {
					for (const j in matches) {

						const file = matches[j];

						// only add files that don't already exist in this.files
						if ((!stopAdding) && (!self.fileExists(file.metadata.id))) {

							const fileObj = {
								name: file.metadata.name,
								path: file.metadata.path_lower,
								id: file.metadata.id,
								size: file.metadata.size,
								width: 0,
								height: 0,
								latitude: 0,
								longitude: 0,
								time_taken: new moment(file.metadata.client_modified).format("x"),
								orientation: 1,
								thumbnail: "",
								loaded: false,
								saved: false,
								error: false
							};

							// get meta data

							self.dbx.filesGetMetadata({
								path: fileObj.path,
								include_media_info: true
							}).then((fileMetaData) => {

								if ((fileMetaData.result.media_info) && (fileMetaData.result.media_info.metadata)) {

									const fileMetaDataData = fileMetaData.result.media_info.metadata;

									if (fileMetaDataData.dimensions) {
										fileObj.width = fileMetaDataData.dimensions.width;
										fileObj.height = fileMetaDataData.dimensions.height;
									}

									if (fileMetaDataData.location) {
										fileObj.latitude = fileMetaDataData.location.latitude;
										fileObj.longitude = fileMetaDataData.location.longitude;
									}

									if (fileMetaDataData.time_taken) {
										fileObj.time_taken = new moment(fileMetaDataData.time_taken).format("x");
									}

								}

							}).catch((err) => {
								// swallow errors
							});

							self.files.push(fileObj);
							filesAdded++;

							if (filesAdded >= resultsMax) {
								stopAdding = true;
								self.sortData();
								break;
							}
						}

					}
				}

				extSearched++;

				if ((!stopAdding) && (extSearched === extLength)) {
					// we've searched all file extensions and reached the end
					self.sortData();
				}

			}).catch((err) => {
				extSearched++;
				if ((extSearched === extLength) && (filesAdded < 1)) {
					// we've searched with all file extensions and found no files
					self.sendSocketNotification("MMM_DROPBOX_ERROR", ERR_MESSAGE);
				}
			});
		};

		// search with all file extensions
		for (const i in this.extensions) {
			if (!stopAdding) {
				const ext = this.extensions[i];
				fileSearch(path, ext, 0);
			}
		}

	},

	sortData () {

		var self = this;

		if (!this.dataTimer) {
			// set time for next data call
			this.dataTimer = setTimeout(() => {
				self.getData();
			}, self.config.dataUpdateInterval);
		}

		// sort this.files based on time_taken property (newest first)
		this.files.sort((a, b) => b.time_taken.localeCompare(a.time_taken));

		// get thumbnails
		this.getThumbnails();

	},

	getThumbnails () {

		const self = this;

		const filesToDownload = []; // temporary array for batch download of thumbnails
		const filesToDownloadError = []; // temporary array for thumbnail errors

		let filesDownloaded = 0; // how many files we've downloaded
		let stopDownloading = false; // when to stop parsing

		if (this.files.length > 0) {

			// set up array op files to be downloaded

			for (const i in this.files) {

				if ((!this.files[i].loaded) && (!this.files[i].error)) {
					if (filesToDownload.length < this.filesToSave) {
						filesToDownload.push({
							path: this.files[i].path,
							size: "w480h320",
							mode: "strict"
						});
						// push to error array as well, so we have something to compare
						// against if there's a download error
						filesToDownloadError.push(this.files[i].id);
					} else {
						break;
					}
				}

			}

			// batch download thumbnails

			if (filesToDownload.length > 0) {

				self.dbx.filesGetThumbnailBatch({
					entries: filesToDownload
				}).then((data) => {

					if (data.result.entries.length > 0) {

						for (const j in data.result.entries) {

							const image = data.result.entries[j];
							const success = (image[".tag"] === "success");
							let imageId = 0;

							if (success) {
								// success loading image
								imageId = image.metadata.id;

							} else {
								// failure loading image
								imageId = filesToDownloadError[j];
							}

							// find file in this.files using the id of the image
							// this returns the original object, so any changes we make will be reflected in this.files
							// this also doesn't work in IE; too bad

							const file = self.files.find((x) => x.id === imageId);

							if (file) {
								if (success) {

									// update file properties
									file.loaded = true;
									file.thumbnail = image.thumbnail; // base64-encoded thumbnail data

								} else {
									// want to make sure this file doesn't get loaded again
									file.loaded = false;
									file.error = true;
								}

							}

						}
					}

					self.saveThumbnails();

				}).catch((err) => {
					// swallow errors
					self.saveThumbnails();
				});

			} else {

				// no new images to download
				self.saveThumbnails();

			}

		} else {
			self.sendSocketNotification("MMM_DROPBOX_ERROR", ERR_MESSAGE);
		}

	},

	saveThumbnails () {
		// this saves the image files into a image_cache directory
		// and also returns the image data to the module

		let filesSaved = 0; // how many files we've saved
		let filesChecked = 0; // how many files we've gone through

		if (this.files.length > 0) {

			for (const i in this.files) {

				filesChecked++;

				const file = this.files[i];
				const filePath = path.join(IMG_FOLDER, file.name);

				if ((file.loaded) && (!file.saved)) {

					if (!fs.existsSync(filePath)) {
						// only write the file if it doesn't already exist
						fs.writeFileSync(filePath, file.thumbnail, { encoding: "base64" });
					}

					file.saved = true;
					file.thumbnail = ""; // we don't want to save this
					filesSaved++;

				}

				// we only save 25 files in every update
				if (filesSaved > (this.filesToSave - 1)) {
					this.notifyModuleSaveDone();
					break;
				} else if (filesChecked === this.files.length) {
					// no more files to save
					this.notifyModuleSaveDone();
				}

			}

		} else {
			this.sendSocketNotification("MMM_DROPBOX_ERROR", ERR_MESSAGE);
		}

	},

	notifyModuleSaveDone () {

		var self = this;
		clearTimeout(this.timer);

		this.sendSocketNotification("MMM_DROPBOX_FILES", this.files);

		this.timer = setTimeout(() => {
			self.sortData();
		}, self.config.updateInterval);

	},

	fileExists (id) {
		return this.files.some((ele) => ele.id === id);
	},

	socketNotificationReceived (notification, payload) {

		if (notification === "MMM_DROPBOX_INIT") {
			this.initialize(payload);

		} else if (notification === "MMM_DROPBOX_GET") {
			this.getData();
		}

	}

});
