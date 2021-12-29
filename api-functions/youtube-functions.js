import { search } from 'youtube-search-without-api-key'

// If 'uncensoredLyrics' is true, then it will automatically add 'uncensored lyrics' to the end of every search
export async function searchYoutube({ songName, author, uncensoredLyrics = false }) {
    // return null if we cannot find a URL
    const query = ` ${songName} ${author ?? ''} ${uncensoredLyrics ? 'uncensored lyrics' : ''}`;
    try {
        const rawData = await search(query);

        // Sometimes rawData is missing a url, title, or duration. If it is missing any of these we don't use it
        const validData = rawData.filter(data => data.duration_raw && data.url && data.title);

        if (rawData.length < 1)
            return null;

        return validData.map(data => {
            let duration = data.duration_raw;

            // If it is in the format like m:ss or h:mm:ss, we turn it into mm:ss or hh:mm:ss respectively
            if (duration.slice(0, duration.indexOf(':')).length < 2)
                duration = ('0' + duration);

            return {
                youtube_url: data.url,
                youtube_title: data.title,
                durationTimestamp: duration,
            }
        })
    } catch (err) {
        console.log('Track.fromSearch will return null because it ran into an error:', err);
        return null;
    }
}

// todo maybe replace call to ytdl.getInfo with something like this idk prolly not
export async function videoInfoFromURL(youtube_url) {
    // return null if url is invalid
}
