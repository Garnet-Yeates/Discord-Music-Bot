import {
	AudioPlayerStatus,
	createAudioPlayer,
	entersState,
	joinVoiceChannel,
	VoiceConnectionDisconnectReason,
	VoiceConnectionStatus,
} from '@discordjs/voice';

import { promisify } from 'node:util';

const wait = promisify(setTimeout);

/**
 * Maps guild IDs to music subscriptions, which exist if the bot has an active VoiceConnection to the guild.
 */
export const subscriptions = new Map();

// looks for an existing Music Subscription for the guild that this channel is on
// if a Music Subscription does not already exist, one will be created automatically and returned 
export function getOrCreateSubscription(voiceChannel, textChannel) {

	const guildId = voiceChannel.guild.id;
	let subscription = subscriptions.get(voiceChannel.guild.id);

	if (subscription) {
		subscription.lastTextChannel = textChannel;
		return subscription;
	}

	// If a subscription does not already exist: we create a new one, add it to the subscription map, and return it
	subscription = new MusicSubscription(
		joinVoiceChannel({
			channelId: voiceChannel.id,
			guildId: voiceChannel.guild.id,
			adapterCreator: voiceChannel.guild.voiceAdapterCreator,
		}),
		textChannel,
		guildId
	);
	subscription.voiceConnection.on('error', console.warn);
	subscriptions.set(voiceChannel.guild.id, subscription);
	return subscription;
}

/**
 * A MusicSubscription exists for each active VoiceConnection. Each subscription has its own audio player and queue,
 * and it also attaches logic to the audio player and voice connection for error handling and reconnection logic.
 */
export class MusicSubscription {

	constructor(voiceConnection, textChannel, guildId) {
		this.voiceConnection = voiceConnection;
		this.audioPlayer = createAudioPlayer();
		this.queue = [];
		this.destroyed = false;
		this.lastTextChannel = textChannel;
		this.guildId = guildId

		this.voiceConnection.on('stateChange', async (_, newState) => {
			if (newState.status === VoiceConnectionStatus.Disconnected) {
				if (newState.reason === VoiceConnectionDisconnectReason.WebSocketClose && newState.closeCode === 4014) {
					/**
					 * If the WebSocket closed with a 4014 code, this means that we should not manually attempt to reconnect,
					 * but there is a chance the connection will recover itself if the reason of the disconnect was due to
					 * switching voice channels. This is also the same code for the bot being kicked from the voice channel,
					 * so we allow 5 seconds to figure out which scenario it is. If the bot has been kicked, we should destroy
					 * the voice connection.
					 */
					try {
						// Probably moved voice channel, give it 5 seconds to join back, else destroy it
						console.log("Situation A (WebSocketClose 4014, possibly recoverable, we will give it 5 seconds)")
						await entersState(this.voiceConnection, VoiceConnectionStatus.Connecting, 5_000);
					} catch {
						console.log("Situation A recovery failed")
						// Probably got disconnected manually
						this.voiceConnection.destroy();
					}
				} else if (this.voiceConnection.rejoinAttempts < 5) {
					console.log("Situation B (disconnected, but possibly recoverable)")
					 // The disconnect in this case is recoverable, and we also have <5 repeated attempts so we will reconnect.
					await wait((this.voiceConnection.rejoinAttempts + 1) * 5_000);
					this.voiceConnection.rejoin();
				} else {
					console.log("Situation B recovery failed ")
					 // The disconnect in this case may be recoverable, but we have no more remaining attempts - destroy.
					this.voiceConnection.destroy();
				}
			} else if (newState.status === VoiceConnectionStatus.Destroyed) {

				// Whenever voice connection is destroyed, this subscription will also be destroyed

				// Whenever the VC is destroyed, this block will eventually run because the state will change to destroyed
				// A lot of this code was taken from an example bot, but I made modifications to the stop() method to destroy the subscription
				// as well (so if the VC is ever destroyed, a new subscription will be made next time a song is requested, so the queue will be lost)
				console.log("The state of the voice connection changed to 'destroyed' so this subscription will end and the queue will be lost")
				this.stop();				
			} else if (
				!this.readyLock &&
				(newState.status === VoiceConnectionStatus.Connecting || newState.status === VoiceConnectionStatus.Signalling)
			) {
				/**
				 * In the Signalling or Connecting states, we set a 20 second time limit for the connection to become ready
				 * before destroying the voice connection. This stops the voice connection permanently existing in one of these
				 * states.
				 */
				this.readyLock = true;
				try {
					console.log("Situation D (vc status changed to 'connecting' or 'signalling'. We give it 15 seconds to reach the 'ready' state)")
					await entersState(this.voiceConnection, VoiceConnectionStatus.Ready, 15_000);
				} catch {
					console.log("Situation D follow up failed (the voice connection did not get to the 'ready' state within 15 seconds of reaching the 'Connecting/Signalling' state")
					if (this.voiceConnection.state.status !== VoiceConnectdionStatus.Destroyed) this.voiceConnection.destroy();
				} finally {
					this.readyLock = false;
				}
			}
		});

		// Configure audio player
		this.audioPlayer.on('stateChange', async (oldState, newState) => {
			console.log('AudioPlayer state changed from:', oldState.status)
			console.log('AudioPlayer state changed to:', newState.status)
			if (newState.status === AudioPlayerStatus.Idle && oldState.status !== AudioPlayerStatus.Idle) {
				// If the Idle state is entered from a non-Idle state, it means that an audio resource has finished playing.
				// The queue is then processed to start playing the next track, if one is available.
				console.log('Situation E: AudioPlayer changed from non idle to idle, so the queue will be processed again since the track is done playing. If a new track is not playing within 30 seconds the vc will be destroyed which will end this subscription');
				
				const currentTrack = (oldState.resource).metadata;

				// When a track fails to download (exit code 1 catch inside track.js), errored is set to true so that the resulting call to 'onFinish' doesn't happen. We want onFinish to call when it finishes without an error 
				// Next time the track is processed thru the queue and track.createAudioResource() is called, it will set errored to false again
				if (!currentTrack.errored)
					(oldState.resource).metadata.onFinish();

				// If we are retrying a song that failed to download (i.e: exit code 1 from youtube-dl-exec) we do not want the queue to process
				// naturally as a result of entering the idle state. What we want to do is re-add the failed track to the queue then call processQueue()
				// ourselves (basically, we don't want another track to start playing before we get a chance to re-try this one). That is what 'wait' is for
				// Note: whenever processQueue is called, subscription.wait will automatically be set back to false
				if (!this.wait) {
					void this.processQueue();

				}
				try {
					await entersState(this.audioPlayer, AudioPlayerStatus.Playing, 30_000);
				}
				catch {
					// For now we log to the console to say that it disconnected due to inactivity
					// In the future I want the MusicSubscription to have a reference to the 'last active channel' or something along the lines
					// (aka, whenever a command is received and the subscription is referenced to play more audio, we will update the reference
					// to the 'last active channel' that this subscription was activated/updated by, so when it inactive kicks itself we can notify)
					this.lastTextChannel.send("Left the channel because you guys weren't giving me attention and I'm a little whore :(")
					console.log("Left the voice channel due to inactivity")
					// If it is not already destroyed (e.g: it was disconnected and was unable to automatically reconnect, or it wasn't able to ever reach the 'ready' state (situations A and D)))
					if (this.voiceConnection.state.status !== VoiceConnectionStatus.Destroyed) {
						this.voiceConnection.destroy();
					}
				}

			} else if (newState.status === AudioPlayerStatus.Playing) {
				// If the Playing state has been entered, then a new track has started playback ***OR*** it recovered from one of the situations above (such as situation A) (which is why we wrap the methods to ensure they are only called once).
				(newState.resource).metadata.onStart();
			}
		});

		this.audioPlayer.on('error', (error) => {
			console.log('audio player ran into an error', error);
			(error.resource).metadata.onError(error);
		});

		voiceConnection.subscribe(this.audioPlayer);
	}

	// Can be awaited but doesn't need to be
	async enqueue(track) {
		console.log('Added `' + track.youtube_title + "` to the queue")
		this.queue.push(track);
		await this.processQueue();
	}

	// Can be awaited but doesn't need to be
	async bulkEnqueue(tracks, autoShuffle = true) {
		console.log('Added `' + tracks.length + "` tracks to the queue")
		this.queue.push(...tracks);
		autoShuffle && this.shuffle();
		await this.processQueue();
	}

	// Can be awaited but doesn't need to be
	async enqueueNext(track) {
		console.log('Added `' + track.youtube_title + "` to the queue")
		this.queue.push(track);
		this.swap(0, this.queue.length - 1);
		await this.processQueue();
	}	

	clear() {
		console.log('cleared')
		this.queue = [];
	}

	// Terminates this subscription
	stop() {
		this.queueLock = true;
		this.queue = [];
		this.audioPlayer.stop(true);
		this.destroyed = true;
		if (this.voiceConnection.state.status !== VoiceConnectionStatus.Destroyed)
			this.voiceConnection.destroy();
		subscriptions.delete(this.guildId);
	}

	nowPlaying() {
		return this.audioPlayer.state.resource.metadata;
	}

	showQueue(pageNumber) {
		// If pageNumber is 0, or not supplied
		if (!pageNumber) {
			
		}
	}

	swap(index1, index2) {
		let temporaryValue = this.queue[index1];
		this.queue[index1] = this.queue[index2];
		this.queue[index2] = temporaryValue;
	}

	shuffle() {
        let currentIndex = this.queue.length, randomIndex;

        while (0 !== currentIndex) {
            randomIndex = Math.floor(Math.random() * currentIndex);
            currentIndex -= 1;

			this.swap(currentIndex, randomIndex);
        }
    }

	/**
	 * Attempts to play a Track from the queue.
	 */
	async processQueue() {
		this.wait = false;
		console.log('processing queue. what will be taken out? ', this.queue[0]?.youtube_title ?? this.queue[0]?.spotify_title)
		// If the queue is locked (already being processed), is empty, or the audio player is already playing something, return
		if (this.queueLock || this.audioPlayer.state.status !== AudioPlayerStatus.Idle || this.queue.length === 0) {
			console.log('Process Queue cancelled because queue lock, audio player status not being idle, or nothing in queue ')
			return;
		}

		// Lock the queue to guarantee safe access
		this.queueLock = true;

		// Take the first item from the queue. This is guaranteed to exist due to the non-empty check above.
		const nextTrack = this.queue.shift();
		try {
			// Attempt to convert the Track into an AudioResource (i.e. start streaming the video)
			const resource = await nextTrack.createAudioResource();
			this.audioPlayer.play(resource);
			this.queueLock = false;
		} catch (error) {
			// If an error occurred, try the next item of the queue instead
			nextTrack.onError(error);
			this.queueLock = false;
			return this.processQueue();
		}
	}
}