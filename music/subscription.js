import {
	AudioPlayerStatus,
	createAudioPlayer,
	entersState,
	joinVoiceChannel,
	VoiceConnectionDisconnectReason,
	VoiceConnectionStatus,
} from '@discordjs/voice';

import { VoiceChannel } from 'discord.js';

import { promisify } from 'node:util';
import Queue from './queue.js';

const wait = promisify(setTimeout);

/**
 * Maps guild IDs to music subscriptions. Each music subscription holds a queue, audioplayer, and an active voice connection for the guild it is mapped to
 */
export const subscriptions = new Map();


/**
 * Looks for an existing Music Subscription for the guild that this voice channel exists on. If one doesn't already exist, it will
 * automatically create one. If one already exists, it will move it to the specified voice channel. It will also update the subscription's
 * most recent text channel (lastTextChannel) and that will now be the channel that the bot responds in with updates about the current track,
 * command responses, etc.
 * 
 * @param {VoiceChannel} voiceChannel the voice channel that the subscription will be created in (if one doesn't already exist) or moved to (if one does exist)
 * @param {import('discord.js').TextBasedChannels} textChannel the text channel that the command was sent in to lead us to this method call
 * @returns 
 */
export function getOrCreateSubscription(voiceChannel, textChannel) {
	const guildId = voiceChannel.guild.id;
	let subscription = subscriptions.get(voiceChannel.guild.id);

	/**
	 * Update (or create if it doesn't already exist) the voice connection. 
	 * 
	 * From discord.js docs: 'If you try to call joinVoiceChannel on another channel in the same guild in which there is already an active voice connection,
	 * the existing voice connection switches over to the new channel' (so even though we aren't updating this.voiceConnection, it is updating automatically just by calling this)
	 * This block of code below is so that if you swtich to a different channel than the bot is currently in, and use /play (or /next, /now) the bot will follow you to the new channel
	 */
	let voiceConnection = joinVoiceChannel({
		channelId: voiceChannel.id,
		guildId: voiceChannel.guild.id,
		adapterCreator: voiceChannel.guild.voiceAdapterCreator,
	});

	// If we already have a subscription, update its last text channel and return it
	if (subscription) {
		subscription.lastTextChannel = textChannel;
		return subscription;
	}

	// If a subscription does not already exist: we create a new one, add it to the subscription map, and return it
	subscription = new MusicSubscription(voiceConnection, textChannel, guildId);
	subscription.voiceConnection.on('error', (err) => console.log('subscription.voiceConnection ran into an error: ', err));
	subscriptions.set(voiceChannel.guild.id, subscription);
	return subscription;
}

/**
 * A MusicSubscription is a guild-specific audio playing class. Each guild that this bot is playing on will have its own MusicSubscription
 * stored in memory on this app. The music subscriptions are accessed via the 'subscriptions' map defined above. 
 * 
 * A music subscription ties together a Guild with a Queue, a VoiceConnection, and an AudioPlayer (which the voice connection is subscribed to). Because
 * of the way discordjs/voice works, the VoiceConnection can be moved from channel to channel (on the same server) without having to make
 * a new subscription or even update the reference. 
 * 
 * The MusicSubscription class attaches logic to both the AudioPlayer and the VoiceConnection in order to implement error recovery and reconnection logic.
 * As a result of this we get a robust music player with a queue that doesn't lock/freeze up.
 * 
 */
export class MusicSubscription {

	constructor(voiceConnection, textChannel, guildId) {
		this.voiceConnection = voiceConnection;
		this.audioPlayer = createAudioPlayer();
		this.queue = new Queue();
		this.destroyed = false;
		this.lastTextChannel = textChannel;
		this.guildId = guildId

		// This differs from the mutex. It is not for synchronizing but instead it cancels calls to processQueue() if one is in progress
		this.queueProcessLock = false;

		// Attach logic to the VoiceConnection to implement error recovery and reconnection logic
		this.voiceConnection.on('stateChange', async (_, newState) => {

			if (newState.status === VoiceConnectionStatus.Disconnected) {

				// WebSocket 4014 means we should not manually try to reconnect. There is a chance the connection can recover if the disconnect was a result of moving
				// voice channels. There is also the possibility it was manually disconnected. Either way, we will give it 5 seconds to reconnect, else we destroy the connection
				if (newState.reason === VoiceConnectionDisconnectReason.WebSocketClose && newState.closeCode === 4014) {
					try {
						// Probably moved voice channel, give it 5 seconds to join back, else destroy it
						console.log("Situation A (WebSocketClose 4014, possibly recoverable, we will give it 5 seconds)")
						await entersState(this.voiceConnection, VoiceConnectionStatus.Connecting, 5e3);
					} catch {
						// Probably got disconnected manually
						console.log("Situation A recovery failed")
						this.voiceConnection.destroy();
					}
				}

				// The disconnect in this case is recoverable, try and rejoin (5 max attempts)
				else if (this.voiceConnection.rejoinAttempts < 5) {
					console.log("Situation B (disconnected, but possibly recoverable)")
					await wait(5e3);
					this.voiceConnection.rejoin();
				} else {
					console.log("Situation B recovery failed (ran out of rejoin attempts) ")
					this.voiceConnection.destroy();
				}
			}

			// Whenever voice connection is destroyed, this subscription will also be destroyed and the queue will be lost for this guild
			else if (newState.status === VoiceConnectionStatus.Destroyed) {
				console.log("The state of the voice connection changed to 'destroyed' so this subscription will end and the queue will be lost")
				this.stop();
			}

			// In the Signalling or Connecting states, we set a 15 second time limit for the connection to become ready before destroying it. This makes
			// it so it cannot permanently exist in one of these 2 states.
			else if (!this.readyLock && (newState.status === VoiceConnectionStatus.Connecting || newState.status === VoiceConnectionStatus.Signalling)) {
				this.readyLock = true;
				try {
					console.log("Situation D (vc status changed to 'connecting' or 'signalling'. We give it 15 seconds to reach the 'ready' state)")
					await entersState(this.voiceConnection, VoiceConnectionStatus.Ready, 15e3);
				} catch {
					console.log("Situation D follow up failed (the voice connection did not get to the 'ready' state within 15 seconds of reaching the 'Connecting/Signalling' state")
					if (this.voiceConnection.state.status !== VoiceConnectionStatus.Destroyed) this.voiceConnection.destroy();
				} finally {
					this.readyLock = false;
				}
			}
		});

		// Attach logic to the AudioPlayer to implement an event driven queue that doesn't lock/freeze up (unless we want it to)
		this.audioPlayer.on('stateChange', async (oldState, newState) => {
			console.log(`AudioPlayer state changed from ${oldState.status} to ${newState.status}`)

			// If the Idle state is entered from a non-Idle state, it means that an audio resource has finished playing. It could also mean that it went from the Buffering state to
			// the Idle state (which means youtube-dl-exec ran into exit code 1). Based on which situation it is, this block will either automatically process the queue or wait for
			// the track to try to replay
			if (newState.status === AudioPlayerStatus.Idle && oldState.status !== AudioPlayerStatus.Idle) {

				console.log('Situation E: AudioPlayer changed from non idle to idle, so the queue will be processed again since the track is done playing. If a new track is not playing within 30 seconds the vc will be destroyed which will end this subscription');

				// When a track fails to download (exit code 1 catch inside track.js), downloadFailed is set to true so that the resulting call to 'onFinish' doesn't happen. Remember, onFinish
				// can only be called once, and we want it to be called when the track actually finishes (not when it fails to download and goes from Buffering to Idle state)
				const currentTrack = (oldState.resource).metadata;
				if (!currentTrack.downloadFailed)
					(oldState.resource).metadata.onFinish();

				// If wait is set to true for this subscription, the queue won't process naturally as a result of the AudioPlayer entering the idle state
				!this.wait && void this.processQueue();

				try {
					await entersState(this.audioPlayer, AudioPlayerStatus.Playing, 30_000);
				}
				catch {
					this.lastTextChannel.send("Left the channel because you guys weren't giving me attention :(")
					console.log("Left the voice channel due to inactivity")

					// If it is not already destroyed (e.g: it was disconnected and was unable to automatically reconnect, or it wasn't able to ever reach the 'ready' state (situations A and D)))
					if (this.voiceConnection.state.status !== VoiceConnectionStatus.Destroyed)
						this.voiceConnection.destroy();
				}

			}

			// If the Playing state has been entered, then a new track has started playback ***OR*** it recovered from one of the situations above (such as situation A) (which is why we wrap the methods to ensure they are only called once).
			else if (newState.status === AudioPlayerStatus.Playing) {
				(newState.resource).metadata.onStart();
			}
		});

		this.audioPlayer.on('error', (error) => {
			console.log('audio player ran into an error', error);
			(error.resource).metadata.onError(error);
		});

		voiceConnection.subscribe(this.audioPlayer);
	}

	skip() {
		this.audioPlayer.stop(true);
	}

	// Terminates this subscription
	async stop() {
		const unlockQueue = await this.queue.acquireLock();
		this.queue.clear();
		unlockQueue();
		this.audioPlayer.stop(true);
		this.destroyed = true;
		if (this.voiceConnection.state.status !== VoiceConnectionStatus.Destroyed)
			this.voiceConnection.destroy();
		subscriptions.delete(this.guildId);
	}

	nowPlaying() {
		return this.audioPlayer.state.resource.metadata;
	}

	/**
	 * Attempts to play a Track from the queue. Concurrent calls are cancelled if a call to this method is in progress
	 */
	async processQueue() {
		this.wait = false;
		console.log('processing queue. what will be taken out? ', this.queue[0]?.youtube_title ?? this.queue[0]?.spotify_title)


		// If the queue is locked (already being processed), is empty, or the audio player is already playing something, return
		if (this.queueProcessLock || this.audioPlayer.state.status !== AudioPlayerStatus.Idle || this.queue.length() === 0) {
			console.log('Process Queue cancelled because queue lock, audio player status not being idle, or nothing in queue ')
			return;
		}

		// Lock the queue to guarantee that processQueue() never runs concurrently (other calls are completely ignored, not waited for like with our mutex lock for queue access)
		this.queueProcessLock = true;

		// Take the first item from the queue. This is guaranteed to exist due to the non-empty check above.
		const unlockQueue = await this.queue.acquireLock();
		const nextTrack = this.queue.dequeue();
		unlockQueue();

		try {
			// Attempt to convert the Track into an AudioResource (i.e. start streaming the video)
			const resource = await nextTrack.createAudioResource();
			this.audioPlayer.play(resource);
			this.queueProcessLock = false;
		} catch (error) {
			console.log(error)
			// If an error occurred, try the next item of the queue instead
			// 99% of the time, we are able to recover from the error (see spawnErrorHandler inside track.js) by downloading a different youtube URL, but in
			// the rare cases where a track is completely unable to play, we need this code block to try the next one and kickstart the natural queue flow
			nextTrack.onError(error);
			this.queueProcessLock = false;
			return await this.processQueue();
		}
	}
}