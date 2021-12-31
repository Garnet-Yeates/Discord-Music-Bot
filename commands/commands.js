import { SlashCommandBuilder } from '@discordjs/builders'

import { GuildMember, MessageEmbed, MessageAttachment } from 'discord.js'
import {
    AudioPlayerStatus,
    entersState,
    joinVoiceChannel,
    VoiceConnectionStatus,
} from '@discordjs/voice';

import { Track } from '../music/track.js';
import { subscriptions, getOrCreateSubscription } from '../music/subscription.js'
import { getSpotifySongsFromPlaylist } from '../api-functions/spotify-functions.js'

// In order for an interaction to be valid for music playing, it must be made by a guild member who is inside of a voice channel
const isInteractionValidForMusic = (interaction) => (interaction && interaction.member instanceof GuildMember && interaction?.member?.voice?.channel?.id && interaction.channel)

const ensureConnectionIsReady = async (subscription) => {
    try {
        await entersState(subscription.voiceConnection, VoiceConnectionStatus.Ready, 15_000);
        return true;
    } catch (error) {
        return false;
    }
}

// The discord.js tutorial recommended putting commands in separate files and loading them dynamically using require() and fs. 
// Since I prefer to use ES modules and therefore cannot take advantage of dynamic loading with require(), my commands are stored in this
// dictionary. Each key is the command name, and each value is an object containing 2 things: the CommandBuilder (used by deploy-commands.js), 
// and an execute function that is called whenever a user executes this command.
const commands = {

    play: {

        commandBuilder: new SlashCommandBuilder()
            .setName('play')
            .setDescription('Enqueues a new track, or unpauses the current track depending on if the "song" option is supplied')
            .addStringOption(option =>
                option.setName('song')
                    .setDescription('Song Name | Youtube URL | Spotify Playlist URL')),

        async execute(interaction, beginningOfQueue = false, now = false) {

            const enqueueYoutubeTrack = commands.play.enqueueYoutubeTrack;

            // if now is set to true it means this execute function was called through the /now command, meaning the current song will get skipped and it will play the requested song immediately
            now && (beginningOfQueue = true)

            // if beginningOfQueue is true, it enqueues it to the beginning of the queue instead of the end
            interaction.deferReply();

            // If the command has an argument, they are not using /play in order to unpause, but rather to queue up a new track
            const userInput = interaction.options.getString('song');

            // Always call isInteractionValidForMusic before calling getOrCreateSubscription to make sure the fields that the subscription needs are defined
            if (!isInteractionValidForMusic(interaction)) {
                interaction.followUp('You must be a user and inside of a voice channel to use this command');
                return;
            }

            // Grabs the existing Music Subscription for this guild, or creates a new one if one does not already exist
            const voiceChannel = interaction.member.voice.channel;
            const textChannel = interaction.channel;
            const requestedBy = interaction.member.nickname || interaction.member.user.username;

            // If they typed something after /play then we will create a subscription no matter what. If they didn't they are using it to unpause so we don't necessarily want to create a subscriptoon

            if (userInput) {

                if (voiceChannel) {

                    // When they type /play <YOUTUBE_URL>
                    if (userInput.toLowerCase().includes("youtube.com/watch")) {

                        const youtube_url = userInput;

                        // Attempt to create a Track from the user's supplied URL. 
                        const track = await Track.fromURL({ youtube_url, requestedBy });
                        if (!track)
                            return interaction.followUp(`Error queuing up track. Make sure the URL is valid, or try again later`);

                        const subscription = getOrCreateSubscription(voiceChannel, textChannel)

                        if (!await ensureConnectionIsReady(subscription))
                            return interaction.followUp('Could not establish a voice connection within 15 seconds, please try again later');

                        track.subscription = subscription;

                        await enqueueYoutubeTrack(track, subscription, interaction, beginningOfQueue, now);
                    }

                    // When they type /play <SPOTIFY_PLAYLIST_URL>
                    else if (userInput.toLowerCase().includes('spotify.com/playlist')) {

                        // you cannot use /now or /next with spotify playlists
                        if (beginningOfQueue)
                            return interaction.followUp('This command cannot be used with spotify playlists');

                        const spotify_url = userInput;

                        const spotifySongs = await getSpotifySongsFromPlaylist(spotify_url);

                        if (!spotifySongs)
                            return interaction.followUp('Could not get playlist information. Please make sure spotify URL is correct, or try again later')

                        // Map all of our spotify songs to spotify tracks. These spotify tracks differ from youtube tracks in the sense that their youtube_title and youtube_url (and alternates)
                        // are not calculated until the moment that the track is about to be played
                        const spotifyTracks = spotifySongs.map(spotifySong =>
                            Track.fromSpotifyInfo({
                                spotify_image_url: spotifySong.image_url,
                                spotify_title: spotifySong.title,
                                spotify_authors: spotifySong.authors.map(author => author.name),
                                requestedBy
                            }));

                        const subscription = getOrCreateSubscription(voiceChannel, textChannel)

                        if (!await ensureConnectionIsReady(subscription))
                            return interaction.followUp('Could not establish a voice connection within 15 seconds, please try again later');

                        for (let track of spotifyTracks)
                            track.subscription = subscription;

                        const unlockQueue = await subscription.queue.acquireLock();
                        subscription.queue.enqueue(...spotifyTracks);
                        subscription.queue.shuffle();
                        unlockQueue();

                        void subscription.processQueue();

                        return interaction.followUp(`Enqueued **${spotifyTracks.length}** tracks from the spotify playlist`)
                    }

                    // When they type /play <YOUTUBE_TITLE> (aka song name)
                    else {
                        const youtube_title = userInput;

                        // Attempt to create a Track from the user's video URL
                        const track = await Track.fromSearch({ searchString: youtube_title, requestedBy });
                        if (!track)
                            return interaction.followUp(`Could not find any tracks based on that search. Try using a less specific search`);

                        const subscription = getOrCreateSubscription(voiceChannel, textChannel)

                        if (!await ensureConnectionIsReady(subscription))
                            return interaction.followUp('Could not establish a voice connection within 15 seconds, please try again later');

                        track.subscription = subscription;

                        await enqueueYoutubeTrack(track, subscription, interaction, beginningOfQueue, now);
                    }
                }
                else {
                    return interaction.followUp("You must be in a voice channel to use this command")
                }

            }
            else {

                const subscription = subscriptions.get(interaction.guildId)

                if (!subscription)
                    return interaction.followUp("Not currently playing on this server");

                if (subscription.audioPlayer.state.status !== AudioPlayerStatus.Paused)
                    return interaction.followUp("Cannot unpause, the audio player is not currently paused. If you are trying to queue up a song, make sure you see the [song] parameter appear while typing the command");

                subscription.lastTextChannel = interaction.channel;

                subscription.audioPlayer.pause();
                return interaction.followUp("Unpaused")
            }
        },

        // Cannot be used for spotify playlistt
        async enqueueYoutubeTrack(track, subscription, deferred_interaction, beginningOfQueue, now) {

            now && (beginningOfQueue = true);

            // Wait for mutex lock for queue to be sure that we are not modifying it concurrently
            const unlockQueue = await subscription.queue.acquireLock();
            if (beginningOfQueue) {
                subscription.queue.enqueueFirst(track);
                unlockQueue();
                if (now)
                    subscription.skip();
                void subscription.processQueue();
                deferred_interaction.followUp(`Enqueued ${"`" + track.youtube_title + "`"} at position ${"`0`"}`);
            }
            else {
                deferred_interaction.followUp(`Enqueued ${"`" + track.youtube_title + "`"} at position ${"`" + (subscription.queue.length()) + "`"}`);
                subscription.queue.enqueue(track);
                unlockQueue();
                void subscription.processQueue();
            }

        }

    },

    next: {

        commandBuilder: new SlashCommandBuilder()
            .setName('next')
            .setDescription(`Same as /play, but adds to the beginning of the queue. Can't be used with a spotify playlist URL`)
            .addStringOption(option =>
                option.setName('song')
                    .setDescription('Song Name | Youtube URL')
                    .setRequired(true)),

        async execute(interaction) {
            return await commands.play.execute(interaction, true);
        }

    },

    now: {

        commandBuilder: new SlashCommandBuilder()
            .setName('now')
            .setDescription(`Same as /play, but skips and plays immediately. Can't be used with a spotify playlist URL`)
            .addStringOption(option =>
                option.setName('song')
                    .setDescription('Song Name | Youtube URL')
                    .setRequired(true)),


        async execute(interaction) {
            return await commands.play.execute(interaction, true, true);
        }

    },

    pause: {

        commandBuilder: new SlashCommandBuilder()
            .setName('pause')
            .setDescription('Pauses the current song'),

        async execute(interaction) {

            const subscription = subscriptions.get(interaction.guildId);

            if (!subscription)
                return interaction.reply("Not currently playing on this server");

            if (subscription.audioPlayer.state.status === AudioPlayerStatus.Paused)
                return interaction.reply("Already paused. You can use /play without entering a song name to unpause");

            subscription.lastTextChannel = interaction.channel;

            subscription.audioPlayer.pause();
            return interaction.reply("Paused")
        }
    },

    shuffle: {

        commandBuilder: new SlashCommandBuilder()
            .setName('shuffle')
            .setDescription('Shuffles the queue'),

        async execute(interaction) {

            const subscription = subscriptions.get(interaction.guildId);

            if (!subscription)
                return interaction.reply("Not currently playing on this server");

            subscription.lastTextChannel = interaction.channel;

            // Wait for the mutex lock for our queue so we don't modify it concurrently. Also adds 'unlockQueueReply' to the interaction
            await subscription.queue.acquireLock(interaction);
            subscription.queue.shuffle();
            return interaction.unlockQueueReply("Shuffled!")
        }
    },

    clear: {

        commandBuilder: new SlashCommandBuilder()
            .setName('clear')
            .setDescription('Clears the queue'),

        async execute(interaction) {

            const subscription = subscriptions.get(interaction.guildId);

            if (!subscription)
                return interaction.reply("Not currently playing on this server");

            subscription.lastTextChannel = interaction.channel;

            // Wait for the mutex lock for our queue so we don't modify it concurrently. Also adds 'unlockQueueReply' to the interaction
            await subscription.queue.acquireLock(interaction);
            subscription.queue.clear();
            return interaction.unlockQueueReply("Queue Cleared!")
        }
    },

    queue: {

        commandBuilder: new SlashCommandBuilder()
            .setName('queue')
            .setDescription('Displays the queue')
            .addStringOption(option =>
                option.setName('page')
                    .setDescription('The page of the queue you want to view')),

        async execute(interaction) {

            const subscription = subscriptions.get(interaction.guildId);

            if (!subscription)
                return interaction.reply({ content: "Not currently playing on this server", ephemeral: true })

            subscription.lastTextChannel = interaction.channel;

            // Wait for the mutex lock for our queue so we don't modify it concurrently. Also adds 'unlockQueueReply' to the interaction
            await subscription.queue.acquireLock(interaction);

            const length = subscription.queue.length();

            if (length == 0)
                return interaction.unlockQueueReply({ content: "The queue is currently empty", ephemeral: true })

            // If the command has an argument, they are not using /play in order to unpause, but rather to queue up a new track
            let page = Number(interaction.options.getString('page'));
            !page && (page = 0);
            page < 0 && (page = 0)

            const resultsPerPage = 10;

            const highestPage = Math.ceil(length / resultsPerPage) - 1;
            page > highestPage && (page = highestPage);

            let end = page * resultsPerPage + resultsPerPage;
            if (end > length)
                end = length;

            const tracks = subscription.queue.slice(page * resultsPerPage, end);

            let currIndex = page * resultsPerPage;

            let string = `${"Queue Page " + "`" + page + "` of " + "`" + highestPage + "`"} `;

            for (let track of tracks) {
                string += '\n' + "`" + currIndex++ + "` " + "`" + (track.youtube_title || track.spotify_title) + "`"
            }

            interaction.unlockQueueReply({ content: string, ephemeral: true })
        }

    },

    swap: {

        commandBuilder: new SlashCommandBuilder()
            .setName('swap')
            .setDescription('Swaps the position of 2 songs in the queue')
            .addStringOption(option =>
                option.setName('index1')
                    .setDescription('The first index being swapped')
                    .setRequired(true))
            .addStringOption(option =>
                option.setName('index2')
                    .setDescription('The second index being swapped')),

        async execute(interaction, overrideIndex1, overrideIndex2) {

            const subscription = subscriptions.get(interaction.guildId);

            if (!subscription)
                return interaction.reply("Not currently playing on this server");

            subscription.lastTextChannel = interaction.channel;

            // Wait for the mutex lock for our queue so we don't modify it concurrently. Also adds 'unlockQueueReply' to the interaction
            await subscription.queue.acquireLock(interaction);

            const length = subscription.queue.length();

            if (length < 2)
                return interaction.unlockQueueReply("If you swap a melon with a melon what do you get? A melon");

            if (!interaction.options.getString('index1'))
                return interaction.unlockQueueReply("At least 1 index must be supplied. If only one is supplied, it will swap with index `0`");

            // If the command has an argument, they are not using /play in order to unpause, but rather to queue up a new track
            const index1 = overrideIndex1 ?? Number(interaction.options.getString('index1').trim());
            if (Number.isNaN(index1))
                return interaction.unlockQueueReply("`index1` must be a number! To see indices, type /queue")

            const index2 = overrideIndex2 ?? Number(interaction.options.getString('index2')?.trim() ?? 0);
            if (Number.isNaN(index2))
                return interaction.unlockQueueReply("`index2` must be a number! To see indices, type /queue")

            if (index1 >= length)
                return interaction.unlockQueueReply("`index1` is too high (the highest index in the queue is `" + (length - 1) + "`)")

            if (index2 >= length)
                return interaction.unlockQueueReply("`index2` is too high (the highest index in the queue is `" + (length - 1) + "`)")

            if (index1 < 0)
                return interaction.unlockQueueReply("`index1` is too low (cannot be below `0`)")

            if (index2 < 0)
                return interaction.unlockQueueReply("`index2` is too low (cannot be below `0`)")

            if (index1 === index2)
                return interaction.unlockQueueReply("If you swap a melon with a melon what do you get? A melon");

            subscription.queue.swap(index1, index2)

            return interaction.unlockQueueReply("Swapped positions `" + index1 + "` and `" + index2 + "` in the queue")
        }
    },

    skip: {

        commandBuilder: new SlashCommandBuilder()
            .setName('skip')
            .setDescription('Skips the current song'),

        async execute(interaction) {

            const subscription = subscriptions.get(interaction.guildId);

            if (!subscription)
                return interaction.reply("Not currently playing on this server");

            subscription.lastTextChannel = interaction.channel;

            // If it is currently loading a track.. 
            const { status } = subscription.audioPlayer.state;
            if (status === AudioPlayerStatus.Idle || status === AudioPlayerStatus.Buffering)
                return interaction.reply("Cannot skip since a track is not playing yet")

            const skipping = subscription.nowPlaying();

            subscription.skip();
            return interaction.reply("Skipped `" + skipping.youtube_title + "`")
        }
    },

    stop: {

        commandBuilder: new SlashCommandBuilder()
            .setName('stop')
            .setDescription('Stops playing on this server. This will cause the bot to leave and the queue to be lost'),

        async execute(interaction) {

            const subscription = subscriptions.get(interaction.guildId);

            if (!subscription)
                return interaction.reply("Not currently playing on this server");

            subscription.lastTextChannel = interaction.channel;

            subscription.stop();

            return interaction.reply("Stopped playing on this server")
        }
    },

    replace: {

        commandBuilder: new SlashCommandBuilder()
            .setName('replace')
            .setDescription('Replaces the currently playing song with the song at the given queue index')
            .addStringOption(option =>
                option.setName('index')
                    .setDescription('The index being swapped with the current song')
                    .setRequired(true)),

        async execute(interaction) {

            const subscription = subscriptions.get(interaction.guildId);

            if (!subscription)
                return interaction.reply("Not currently playing on this server");

            subscription.lastTextChannel = interaction.channel;

            // Wait for the mutex lock for our queue so we don't modify it concurrently. Also adds 'unlockQueueReply' to the interaction
            const unlockQueue = await subscription.queue.acquireLock(interaction);

            if (!interaction.options.getString('index'))
                return interaction.unlockQueueReply("A queue `index` must be specified for this command`");

            const index = Number(interaction.options.getString('index').trim())
            if (Number.isNaN(index))
                return interaction.unlockQueueReply("`index` must be a number! To see indices, type /queue")

            if (index <= 0) {
                return interaction.unlockQueueReply("Replacing with index `0` is the same as /skip. Just use /skip")
            }

            const length = subscription.queue.length();

            if (index >= length) {
                return interaction.unlockQueueReply("`index` too high (the highest index in the queue is `" + (length - 1) + "`)")
            }

            const trackAtIndex = subscription.queue.get(index);

            // Take the song out of its position and put it at index 0, pushing everything else up by 1 index
            const [removed] = subscription.queue.splice(index, 1);
            subscription.queue.splice(0, 0, removed);
            console.log(subscription.queue.internal[0])
            unlockQueue();

            interaction.reply('Replacing the currently playing song with the one at index `' + index + '` (`' + (trackAtIndex.youtube_title ?? trackAtIndex.spotify_title) + '`)')

            subscription.skip();
        }
    },

    jump: {

        commandBuilder: new SlashCommandBuilder()
            .setName('jump')
            .setDescription('Skips all songs in the queue (including current) up to the given queue index')
            .addStringOption(option =>
                option.setName('index')
                    .setDescription('The index being jumped to')
                    .setRequired(true)),

        async execute(interaction) {

            const subscription = subscriptions.get(interaction.guildId);

            if (!subscription)
                return interaction.reply("Not currently playing on this server");

            subscription.lastTextChannel = interaction.channel;

            // Wait for the mutex lock for our queue so we don't modify it concurrently. Also adds 'unlockQueueReply' to the interaction
            const unlockQueue = await subscription.queue.acquireLock(interaction);

            if (!interaction.options.getString('index'))
                return interaction.unlockQueueReply("A queue index must be specified for this command`");

            const length = await subscription.queue.length();

            const index = Number(interaction.options.getString('index').trim())
            if (Number.isNaN(index))
                return interaction.unlockQueueReply("`index` must be a number! To see indices, use /queue")

            if (index <= 0) {
                return interaction.unlockQueueReply("Jumping to index 0 is the same as /skip. Just use /skip")
            }

            if (index >= length) {
                return interaction.unlockQueueReply("`index` too high (the highest index in the queue is `" + (length - 1) + "`)")
            }

            interaction.reply('Skipping the current song and jumping to position `' + index + '`')
            subscription.queue.jump(index);
            unlockQueue();

            subscription.skip();
        }

    },

    remove: {

        commandBuilder: new SlashCommandBuilder()
            .setName('remove')
            .setDescription('Removes the specified index from the queue')
            .addStringOption(option =>
                option.setName('index')
                    .setDescription('The index being removed from the queue')
                    .setRequired(true)),

        async execute(interaction) {

            const subscription = subscriptions.get(interaction.guildId);

            if (!subscription)
                return interaction.reply("Not currently playing on this server");

            subscription.lastTextChannel = interaction.channel;

            // Wait for the mutex lock for our queue so we don't modify it concurrently. Also adds 'unlockQueueReply' to the interaction
            const unlockQueue = await subscription.queue.acquireLock(interaction);

            if (!interaction.options.getString('index'))
                return interaction.unlockQueueReply("A queue index must be specified for this command`");

            const length = subscription.queue.length();

            const index = Number(interaction.options.getString('index').trim())
            if (Number.isNaN(index))
                return interaction.unlockQueueReply("`index` must be a number! To see indices, use /queue")

            if (index < 0) {
                return interaction.unlockQueueReply("`index` too low. To see indices, use /queue")
            }

            if (index >= length) {
                return interaction.unlockQueueReply("`index` too high (the highest index in the queue is `" + (length - 1) + "`)")
            }

            const trackAtIndex = subscription.queue.get(index);

            interaction.reply('Removing the song at position`' + index + '` (`' + (trackAtIndex.youtube_title ?? trackAtIndex.spotify_title) + '`) from the queue')

            subscription.queue.remove(index);
            unlockQueue();
        }

    },

    move: {

        commandBuilder: new SlashCommandBuilder()
            .setName('move')
            .setDescription('Moves the bot to the channel you are currently in'),

        async execute(interaction) {

            const subscription = subscriptions.get(interaction.guildId);

            if (!subscription)
                return interaction.reply("Not currently playing on this server");

            subscription.lastTextChannel = interaction.channel;

            // isInteractionValidForMusic() makes sure they are a GuildMember inside of a voice channe 
            if (!isInteractionValidForMusic(interaction))
                return interaction.reply('You must be a user and inside of a voice channel to use this command');

            // Grabs the existing Music Subscription for this guild, or creates a new one if one does not already exist
            const voiceChannel = interaction.member.voice.channel;

            /* "If you try to call joinVoiceChannel on another channel in the same guild in which there is already an active
             * voice connection, the existing voice connection switches over to the new channel" the docs better not have lied 
             */
            joinVoiceChannel({
                channelId: voiceChannel.id,
                guildId: voiceChannel.guild.id,
                adapterCreator: voiceChannel.guild.voiceAdapterCreator,
            });

            return interaction.reply("Moved!")
        }
    },
}

export default commands;