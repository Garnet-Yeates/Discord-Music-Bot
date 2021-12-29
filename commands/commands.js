import { SlashCommandBuilder } from '@discordjs/builders';

import { GuildMember, MessageEmbed, MessageAttachment } from 'discord.js';
import {
    AudioPlayerStatus,
    entersState,
    joinVoiceChannel,
    VoiceConnectionStatus,
} from '@discordjs/voice';

import { Track } from '../music/track.js';
import { subscriptions, getOrCreateSubscription } from '../music/subscription.js';
import { getSpotifySongsFromPlaylist } from '../api-functions/spotify-functions.js';

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
            let subscription = userInput ? getOrCreateSubscription(voiceChannel, textChannel) : subscriptions.get(interaction.guildId)

            // For the lifeCycleFunctions, even though they are wrapped, I bound 'this' to be the current track that is playing
            const lifeCycleFunctions = {
                onStart() {

                    const messageData = {};

                    const youtubeIcon = new MessageAttachment('./assets/youtube_icon.png');

                    console.log('raw timestamp', this.durationTimestamp);

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

                    if (this.spotify_title) {
                        if (this.spotify_image_url) {
                            embed.setThumbnail(this.spotify_image_url)
                            delete messageData.files;
                        }
                        embed.setTitle(`${this.spotify_author} - ${this.spotify_title} `)
                        embed.setDescription(`Youtube Song Name: ${"`" + this.youtube_title + "`"} \n ${embed.description}`)
                    }
                    this.subscription.lastTextChannel.send(messageData);
                },
                onFinish() {
                    this.subscription.lastTextChannel.send(`Finished playing ${"`" + this.youtube_title + "`"}. There are currently ${"`" + this.subscription.queue.length + "`"} songs left in the queue`)
                },
                onError(error) {
                    console.warn(error);
                    interaction.followUp({ content: `Error: ${error}` }).catch(console.warn);

                    interaction.followUp({ content: `Error.message: ${error.message}` }).catch(console.warn);
                },
            }

            if (userInput) {

                if (voiceChannel) {

                    // When they type /play <YOUTUBE_URL>
                    if (userInput.toLowerCase().includes("youtube.com/watch")) {

                        const youtube_url = userInput;

                        if (!await ensureConnectionIsReady(subscription))
                            return interaction.followUp('Could not establish a voice connection within 15 seconds, please try again later');

                        // Attempt to create a Track from the user's supplied URL. 
                        const track = await Track.fromURL({ youtube_url, lifeCycleFunctions, requestedBy, subscription });
                        if (!track)
                            return interaction.followUp(`Error queuing up track. Make sure the URL is valid, or try again later`);

                        enqueueYoutubeTrack(track, subscription, interaction, beginningOfQueue, now);
                    }

                    // When they type /play <SPOTIFY_PLAYLIST_URL>
                    else if (userInput.toLowerCase().includes('spotify.com/playlist')) {

                        // you cannot use /now or /next with spotify playlists
                        if (beginningOfQueue)
                            return interaction.followUp('This command cannot be used with spotify playlists');

                        const spotify_url = userInput;

                        // When subscriptions are instantialized, a VoiceConnection is automatically created via the call to 'joinVoiceChannel'. So there *should* be a 'ready' connection
                        // So here we are ensuring that the VoiceConnection is in the 'ready' state before queuing up new music
                        if (!ensureConnectionIsReady(subscription))
                            return interaction.followUp('Could not establish a voice connection within 15 seconds, please try again later');

                        const spotifySongs = await getSpotifySongsFromPlaylist(spotify_url);

                        if (!spotifySongs)
                            return interaction.followUp('Could not get playlist information. Please make sure spotify URL is correct, or try again later')

                        // Map all of our spotify songs to spotify tracks. These spotify tracks differ from youtube tracks in the sense that their youtube_title and youtube_url (and alternates)
                        // are not calculated until the moment that the track is about to be played
                        const spotifyTracks = await Promise.all(spotifySongs.map(async spotifyTrack => {

                            const { duration, image_url: spotify_image_url, title: spotify_title, author: spotify_author } = spotifyTrack;

                            return await Track.fromSpotifyInfo({ spotify_image_url, spotify_title, spotify_author, lifeCycleFunctions, requestedBy, subscription });
                        }));

                        subscription.bulkEnqueue(spotifyTracks);

                        return interaction.followUp(`Enqueued **${spotifySongs.length}** tracks from the spotify playlist`)
                    }

                    // When they type /play <YOUTUBE_TITLE> (aka song name)
                    else {
                        const youtube_title = userInput;

                        if (!await ensureConnectionIsReady(subscription))
                            return interaction.followUp('Could not establish a voice connection within 15 seconds, please try again later');

                        // Attempt to create a Track from the user's video URL
                        const track = await Track.fromSearch({ search: youtube_title, requestedBy, subscription, lifeCycleFunctions });
                        if (!track)
                            return interaction.followUp(`Could not find any tracks based on that search. Try using a less specific search`);

                        enqueueYoutubeTrack(track, subscription, interaction, beginningOfQueue, now);
                    }
                }
                else {
                    return interaction.followUp("You must be in a voice channel to use this command")
                }

            }
            else {

                const subscription = subscriptions.get(interaction.guildId);

                if (!subscription)
                    return interaction.followUp("Not currently playing on this server");

                if (subscription.audioPlayer.state.status !== AudioPlayerStatus.Paused)
                    return interaction.followUp("Cannot unpause, the audio player is not currently paused. If you are trying to queue up a song, make sure you see the [song] parameter appear while typing the command");

                subscription.lastTextChannel = interaction.channel;

                subscription.audioPlayer.pause();
                return interaction.followUp("Unpaused")
            }
        }
    },

    next: {

        commandBuilder: new SlashCommandBuilder()
            .setName('next')
            .setDescription(`Same as /play, but adds to the beginning of the queue. Can't be used with a spotify playlist URL`)
            .addStringOption(option =>
                option.setName('song')
                    .setDescription('Song Name | Youtube URL')),

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
                    .setDescription('Song Name | Youtube URL')),


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

            subscription.shuffle();

            return interaction.reply("Shuffled!")
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

            subscription.clear();

            return interaction.reply("Queue Cleared!")
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

            if (subscription.queue.length == 0)
                return interaction.reply({ content: "The queue is currently empty", ephemeral: true })

            // If the command has an argument, they are not using /play in order to unpause, but rather to queue up a new track
            let page = Number(interaction.options.getString('page'));
            !page && (page = 0);

            const resultsPerPage = 10;

            const highestPage = Math.ceil(subscription.queue.length / resultsPerPage) - 1;
            page > highestPage && (page = highestPage);

            let end = page * resultsPerPage + resultsPerPage;
            if (end > subscription.queue.length)
                end = subscription.queue.length;

            const tracks = subscription.queue.slice(page * resultsPerPage, end);
            let currIndex = page * resultsPerPage;

            let string = `${"Queue Page " + "`" + page + "` of " + "`" + highestPage + "`"} `;

            for (let track of tracks) {
                string += '\n' + "`" + currIndex++ + "` " + "`" + (track.youtube_title || track.spotify_title) + "`"
            }

            interaction.reply({ content: string, ephemeral: true })
        }

    },

    swap: {

        commandBuilder: new SlashCommandBuilder()
            .setName('swap')
            .setDescription('Swaps the position of 2 songs in the queue')
            .addStringOption(option =>
                option.setName('index1')
                    .setDescription('The first index being swapped'))
            .addStringOption(option =>
                option.setName('index2')
                    .setDescription('The second index being swapped')),

        async execute(interaction) {

            const subscription = subscriptions.get(interaction.guildId);

            if (!subscription)
                return interaction.reply("Not currently playing on this server");

            if (subscription.queue.length < 2) {
                return interaction.reply("If you swap a melon with a melon what do you get? A melon");
            }

            console.log("index 1: " + interaction.options.getString('index1').trim());
            console.log("index 2: " + interaction.options.getString('index2').trim());

            // If the command has an argument, they are not using /play in order to unpause, but rather to queue up a new track
            const index1 = Number(interaction.options.getString('index1').trim());
            if (Number.isNaN(index1))
                return interaction.reply("Index must be a number! To see indices, type /queue")

            const index2 = Number(interaction.options.getString('index2').trim());
            if (Number.isNaN(index2))
                return interaction.reply("Index must be a number! To see indices, type /queue")

            index1 > subscription.queue.length && (index1 = queue.length - 1);
            index2 > subscription.queue.length && (index2 = queue.length - 1);

            if (index1 === index2)
                return interaction.reply("Indices cannot be the same")

            if (index1 < 0 || index2 < 0) {
                return interaction.reply("Index can't be less than 0")
            }

            subscription.lastTextChannel = interaction.channel;

            subscription.swap(index1, index2)

            return interaction.reply("Swapped positions `" + index1 + "` and `" + index2 + "` in the queue")
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

            // Calling stop switches the audioPlayer to the Idle state which triggers situation e (process queue, check for inactivity) in subscription.js
            subscription.audioPlayer.stop();
            return interaction.reply("Skipped `" + skipping.youtube_title + "`")
        }
    },

    skip: {

        commandBuilder: new SlashCommandBuilder()
            .setName('stop')
            .setDescription('Stops playing on this server. This will cause the bot to leave and the queue to be lost'),

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

            // Calling stop switches the audioPlayer to the Idle state which triggers situation e (process queue, check for inactivity) in subscription.js. This effectively skips this track
            subscription.audioPlayer.stop();
            return interaction.reply("Skipped `" + skipping.youtube_title + "`")
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


// Cannot be used for spotify playlistt
async function enqueueYoutubeTrack(track, subscription, deferred_interaction, beginningOfQueue, now) {

    now && (beginningOfQueue = true);

    if (beginningOfQueue) {
        subscription.enqueueNext(track); 
        if (now)
            subscription.audioPlayer.stop(true); // stop switches audioplayer to idle state which processess queue
        deferred_interaction.followUp(`Enqueued ${"`" + track.youtube_title + "`"} at position ${"`0`"}`);
    }
    else {
        deferred_interaction.followUp(`Enqueued ${"`" + track.youtube_title + "`"} at position ${"`" + (subscription.queue.length) + "`"}`);
        subscription.enqueue(track);
    }

}

export default commands;