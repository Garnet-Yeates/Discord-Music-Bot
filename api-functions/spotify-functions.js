/**
 * This module does 2 things:
 * a) once it is read by index.js (i.e when the bot starts), it authorizes SpotifyWebApi using credneitlas from my spotify application
 * b) it exports a function (getPlaylistTrackNamesAsync) that will be used by the bot to get all the song names from a spotify playlist link
 */

import SpotifyWebApi from 'spotify-web-api-node';

const spotifyApi = new SpotifyWebApi({
    clientId: process.env.SPOTIFY_APP_CLIENT_ID,
    clientSecret: process.env.SPOTIFY_APP_CLIENT_SECRET,
});

// Grants access for 3600 seconds (1 hour)
async function authorizeSpotify() {
    const data = await spotifyApi.clientCredentialsGrant();
    console.log('Spotify has been authorized, the access token will expire in ' + data.body['expires_in'] + " seconds");

    // Save the access token so that it's used in future calls by the files that import this module
    spotifyApi.setAccessToken(data.body['access_token']);
}

// We await our authorizeSpotify call because we want to make sure we have the token set before we try and use it
await authorizeSpotify();
setInterval(authorizeSpotify, 3300 * 1000); // Every 3300 seconds (55 minutes), we call authorizeSpotify again to refresh the spotifyApi access token 

// Returns null if there is any error along the way (i.e invalid playlist link, or error hitting spotify API)
export async function getSpotifySongsFromPlaylist(playlist_url) {

    const playlist_id = spotifyURLToPlaylistId(playlist_url)
    if (!playlist_id) {
        return null;
    }

    try {
        // This loop adds 100 tracks at a time to an array, 'items'. The reason why it adds only 100 at a time instead of all at once is because
        // Spotify set a max value for the 'limit' route parameter in the API call. Once the API call returns an empty list, the loop ends
        let response, items = [], offset = 0;
        do {
            // Makes a GET request to https://api.spotify.com/v1/playlists/{playlist_id}/tracks, grabbing the 'items.track' field and ignoring the 'items.addby_id' field
            response = await spotifyApi.getPlaylistTracks(playlist_id, {
                offset,
                limit: 100,
                fields: 'items.track'
            });

            items.push(...response.body.items.map(item => ({
                title: item.track.name,
                authors: item.track.artists.length > 0 ? item.track.artists : undefined,
                image_url: item.track.album.images[2]?.url,
            })));

            offset += 100;
        }
        while (response.body.items.length > 0);

        return items;
    } catch (err) {
        console.log(err)
        return null;
    }

}

// Helper function used by getPlaylistTrackNamesAsync
function spotifyURLToPlaylistId(url) {
    // If the URL doesn't include a '/' we assume they supplied the direct playlist id which is a really nerdy thing to do
    if (!url.includes('/'))
        return null;
    if (url.includes('?') && url.indexOf('?') > url.lastIndexOf('/'))
        return url.slice(url.lastIndexOf('/') + 1, url.indexOf('?'))
    if (!url.includes('?') && url.lastIndexOf('/') < url.length)
        return url.slice(url.lastIndexOf('/') + 1)
    return null;
}

