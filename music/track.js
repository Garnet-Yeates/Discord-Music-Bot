import { createAudioResource, demuxProbe } from '@discordjs/voice';

// in the tutorial, they import { getInfo } as a named export but that doesn't work with this ES module so I do ytdl.getInfo (appears to work fine)
import ytdl from 'ytdl-core';

import TimeFormat from 'hh-mm-ss';

// in the tutorial they import youtubedl.raw as ytdl and use that. That function says it doesn't exist so I use .exec()
import youtubedl from 'youtube-dl-exec';
import { searchYoutube } from '../api-functions/youtube-functions.js';

const noop = () => { };

/**
 * A Track represents information about a YouTube video or Spotify song that can be added to a queue.
 * It contains the title and URL of the video, as well as functions onStart, onFinish, onError, that act
 * as callbacks that are triggered at certain points during the track's lifecycle.
 *
 * Rather than creating an AudioResource for each video immediately and then keeping those in a queue,
 * we use tracks as they don't pre-emptively load the videos. Instead, once a Track is taken from the
 * queue, it is converted into an AudioResource just in time for playback. Spotify tracks don't gain
 * a youtube_url or youtube_title until the moment they are about to play.
 * 
 */
export class Track {

	constructor({ youtube_url, youtube_title, spotify_title, spotify_main_author, spotify_authors, spotify_image_url, requestedBy, durationTimestamp, onStart, onFinish, onError }) {

		this.youtube_url = youtube_url;        // All tracks are guaranteed to have a youtube_url and youtube_title at the time onStart() is called
		this.youtube_title = youtube_title;    // (spotify tracks don't get theirs until the moment they are taken from the queue. Why? see Track.fromSpotifyInfo for an explanation)

		this.spotify_title = spotify_title;      // only tracks that are queued up from spotify will have these properties filled out. When a spotify track plays, it
		this.spotify_authors = spotify_authors;  // shows both spotify title and the calculated youtube title, so users can see if there is a disparity
		this.spotify_image_url = spotify_image_url;
		this.spotify_main_author = spotify_main_author;

		this.requestedBy = requestedBy;
		this.durationTimestamp = durationTimestamp;

		this.currentReplayAttempt = 0;

		this.alternate_youtube_videos = [];
	}

	getSpotifyAuthorString(maxAuthorCount = 0) {
		maxAuthorCount === 0 && (maxAuthorCount = this.spotify_authors.length)
		if (!this.spotify_authors)
			return null;
		let str = this.spotify_authors[0];
		for (let i = 1; i < maxAuthorCount; i++)
			str += ` ${this.spotify_authors[i]}`
		return str;
	}

	// Lifecycle functions onStart, onFinish, and onError are guaranteed to only be called once. Why must we guarantee this? e.g: any time the audioPlayer transitions
	// to the playing state, onStart is called so if we don't wrap it, then making the bot move voice channels will cause AudioPlayer state change
	// (as a result of going from AutoPaused to Playing during the interruption of the VoiceConnection), meaning onStart() will get called again.
	onStart() {

		if (this.started)
			return;
		this.started = true;

		const messageData = {};

		const youtubeIcon = new MessageAttachment('./assets/youtube_icon.png');

		const embed = new MessageEmbed()
			.setColor('#0099ff')
			.setTitle(this.youtube_title)
			.setURL(this.youtube_url)
			.setAuthor('Now Playing:')
			.setDescription(`Requested by: ${"`" + this.requestedBy + "`"} \n Duration: ${"`" + this.durationTimestamp + "`"}`)
			.setThumbnail('attachment://youtube_icon.png')
			.setTimestamp()
			.setFooter(`Filler text but still has less filler than Naruto Shippuden` + "\u3000".repeat(2) + "|", 'https://i.imgur.com/AfFp7pu.png');

		messageData.files = [youtubeIcon]
		messageData.embeds = [embed]

		this.subscription.lastTextChannel.guild.members.cache.get(client.user.id).setNickname('garnbot')

		if (this.spotify_title) {

			if (this.spotify_authors) {
				this.subscription.lastTextChannel.guild.members.cache.get(client.user.id).setNickname(`garnbot [${this.getSpotifyAuthorString(1)}]`)
			}

			if (this.spotify_image_url) {
				embed.setThumbnail(this.spotify_image_url)
				delete messageData.files;
			}
			embed.setTitle(`${this.getSpotifyAuthorString(1)} - ${this.spotify_title} `)
			embed.setDescription(`Youtube Song Name: ${"`" + this.youtube_title + "`"} \n ${embed.description}`)
		}
		this.subscription.lastTextChannel.send(messageData);
	}

	onFinish() {
		if (this.finished)
			return;
		this.finished = true;

		this.subscription.lastTextChannel.guild.members.cache.get(client.user.id).setNickname('garnbot')
                    this.subscription.lastTextChannel.send(`Finished playing ${"`" + this.youtube_title + "`"}. There are currently ${"`" + this.subscription.queue.length + "`"} songs left in the queue`)
	}

	onError() {
		if (this.errored)
			return;
		this.errored = true;

		interaction.followUp({ content: `Error: ${error}` });

		interaction.followUp({ content: `Error.message: ${error.message}` });
	}

	/**
	 * Creates an AudioResource from this Track. This track will either have a URL already so we can simply call Track.createAudioResourceFromURL(), or
	 * a Title and Author will be supplied so we can search youtube for the most relevant video based on the title and author and find a URL then recurse
	 */
	createAudioResource() {

		this.downloadFailed = false;
		console.log('CreateAudioResource called for: ' + (this.youtube_title || this.spotify_title))

		return new Promise((resolve, reject) => {

			// If they do not supply a URL, they must supply a title and an author so we can search youtube for the song and grab a URL for them
			if (!this.youtube_url) {

				if (!this.spotify_title)
					return reject('I am a bad coder')

				searchYoutube({ songName: this.spotify_title, author: this.getSpotifyAuthorString(2), uncensoredLyrics: true }).then((searchResults) => {

					if (!searchResults) {
						this.subscription.lastTextChannel.send('Could not find a Youtube URL relevant to the Spotify song `' + this.getSpotifyAuthorString() + " - " + this.spotify_title + "`. This track will be skipped.")
						return reject('Could not find youtube URL for this spotify track');
					}

					this.youtube_url = searchResults[0].youtube_url;
					this.youtube_title = searchResults[0].youtube_title;
					this.durationTimestamp = searchResults[0].durationTimestamp;

					for (let i = 1; i < searchResults.length; i++) {
						this.alternate_youtube_videos[i - 1] = searchResults[i];
					}

					resolve(this.createAudioResource()); // Recurse, but this time we will have a youtube_url, so it hits the else block
				})
			}

			// Otherwise, since we already have the URL, we simply call createAudioResourceFromURL
			else {
				const process = youtubedl.exec(
					this.youtube_url,
					{ o: '-', q: '', f: 'bestaudio[ext=webm+acodec=opus+asr=48000]/bestaudio', r: '100K', },
					{ stdio: ['ignore', 'pipe', 'ignore'] },
				);

				if (!process.stdout) {
					reject(new Error('No stdout'));
					return;
				}
				const stream = process.stdout;

				// This is our errorHandler that is referenced below (process.once('spawn').catch(spawnErrorHandler))
				// It handles errors that occur when the process that we get from youtubedl.exec spawns. What it does is
				// it re-queues this track again at the beginning of the queue, and freezes the queue temporarily to allow
				// this track to get processed again. This is all in an attempt to try loading it again a couple of times (max 3)
				// if loading fails after 3 attempts, the track is skipped
				const spawnErrorHandler = (error) => {
					console.log(error.shortMessage);

					if (!process.killed) process.kill();

					// Sometimes the video fails to download with exit code 1. Usually trying 1 more attempt after fixes the issue.
					// In rarer cases, sometimes a youtube URL doesn't work at all with youtubedl.exec no matter how many times we try
					// so in the casse where they didn't specify a specific youtube URL, we can look for alternative URLs for them
					if (error.shortMessage.toLowerCase().includes("exit code 1")) {

						this.currentReplayAttempt++;

						if (this.currentReplayAttempt < 5) {

							// After the second failed replay, it will switch the URL to an alternate one if one exists for the next attempt to load
							if (this.currentReplayAttempt >= 2) {

								// After the second replay attempt we will use alternates[0], on the after the third it will use alternates[1]... etc
								const alternateVideo = this.alternate_youtube_videos[this.currentReplayAttempt - 2];

								// If we have an alternate video at this position...
								if (alternateVideo) {

									this.subscription.lastTextChannel.send(`Failed to play ${"`" + this.youtube_title + "`"}, Trying again with a different youtube URL (${4 - this.currentReplayAttempt} attempts left after this attempt)`)

									this.youtube_title = alternateVideo.youtube_title;
									this.youtube_url = alternateVideo.youtube_url;
									this.durationTimestamp = alternateVideo.durationTimestamp;
								}
								else {
									this.subscription.lastTextChannel.send(`Failed to play ${"`" + this.youtube_title + "`"}, Could not find an alternate youtube URL, trying with the same one (${4 - this.currentReplayAttempt} attempts left after this attempt)`)
								}
							}
							else {
								this.subscription.lastTextChannel.send(`Failed to play ${"`" + this.youtube_title + "`"}, Trying again (${4 - this.currentReplayAttempt} attempts left after this attempt)`)
							}

							this.downloadFailed = true; // Set errored to 'true' so that the next call to onFinish() as a result of the track ending abruptly doesn't get called (methods are wrapped so they only call once)

							// Tells the subscription event handlers to not automatically process the queue as a result of the audio player going idle. Calls to processQueue() will automatically set 
							// wait back to false. After we call stop() below we want to make sure that another random track doesn't start playing because we want to give this track a chance to play, hence using 'wait'
							this.subscription.wait = true;

							// Call stop(true) to force stop. Right now the track is in the buffering state, and if we don't force stop it, it will end up in the 'playing state' for a brief moment
							// before the audioPlayer realizes it is broken. This means onStart() will get called when we don't want it to because it's not actually starting!
							this.subscription.audioPlayer.stop(true);

							// Because of our calls to wait() and stop(), we can ensure that the track will be the one that plays next
							this.subscription.enqueueNext(this);
						}
					}

					stream.resume();
					reject("Error occured during the spawn of the process downloaded from youtube-download-exec");
				};


				process.once('spawn', async () => {
					try {
						const { stream: probedStream } = await demuxProbe(stream);

						// Any time you see audioPlayer.state.audioResource.metaData (like in subscription.js) you know it's referring to the current track
						resolve(createAudioResource(probedStream, { metadata: this }));
					} catch (err) {
						console.log('demuxProbe ran into an error', err.shortMessage);
						reject(err)
					}
				}).catch(spawnErrorHandler);
			}
		});
	}

	/**t
	 * The youtube URL and alternate URLS will be computed at the time that createAudioResource() is called (i.e when it is this Track's turn to play)
	 * The reason for this is it takes ~500ms to search youtube to get the URL from the track info (title, author, etc) for 
	 * each song. So if they add a 300 song spotify playlist, it would take like 5 minutes to process their request trying
	 * to get all the links, create all the tracks, and bulk queue them. So instead we queue the songs up without a computed URL yet,
	 * and we get the relevant URLs as the song is about to play, based on the spotify info such as title and author
	 * @param {} songTitle 
	 * @param {*} author 
	 * @returns 
	 */
	static fromSpotifyInfo({ spotify_image_url, spotify_title, spotify_main_author, spotify_authors, requestedBy, durationTimestamp, subscription }) {

		return new Track({ spotify_image_url, spotify_title, spotify_main_author, spotify_authors, requestedBy, durationTimestamp });
	}


	/**
	 * Creates a track from a basic search. This is used when a user types /play <YOUTUBE_TITLE>
	 * When it searches youtube, it sets the youtube_url for the track to the most relevant video that searchYoutube() could find.
	 * It also saves the all of the other videos it found as 'alternate_youtube_videos' for the track (just in case the bot is unable
	 * to download data from a specific url for some reason, which I've seen happen a lot)
	 * @param {} param0 
	 * @returns a track if it was able to find any search results, or null if it could not find any search results
	 */
	static async fromSearch({ searchString, requestedBy }) {

		const searchResults = await searchYoutube({ songName: searchString });

		if (!searchResults) {
			console.log('Track.fromSearch will return null because no search results were found');
			return null;
		}

		const youtube_url = searchResults[0].youtube_url;
		const youtube_title = searchResults[0].youtube_title;
		const durationTimestamp = searchResults[0].durationTimestamp;

		const track = new Track({ youtube_title, youtube_url, requestedBy, durationTimestamp });

		for (let i = 1; i < searchResults.length; i++) {
			track.alternate_youtube_videos[i - 1] = searchResults[i];
		}

		return track;
	}

	/**
	 * Creates a Track from a youtube video URL
	 *
	 * @param youtube_url The URL of the youtube video
	 *t
	 * @returns The created Track
	 */
	static async fromURL({ youtube_url, requestedBy }) {
		try {
			const info = await ytdl.getInfo(youtube_url);

			const { title: youtube_title, lengthSeconds } = info.videoDetails;
			const durationTimestamp = TimeFormat.fromS(Number(lengthSeconds));

			const track = new Track({ youtube_title, youtube_url, requestedBy, durationTimestamp });

			return track;
		}
		catch (err) {
			console.log('Track.fromURL will return null because it ran into the following error:', err);
			return null;
		}
	}
}


