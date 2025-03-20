# Twitter/X Post Scraper

A utility to scrape tweets from Twitter/X profiles using Playwright. Extracts post links and can download tweet content including text, images, and videos.

## Features

- Scrapes tweets from any Twitter/X user profile
- Extracts tweet links, text content, images, and video information
- Intelligently processes tweets based on content complexity:
  - Simple tweets (text and images only) are processed directly on the timeline
  - Complex tweets (with videos, polls, "Show more" buttons, etc.) are processed individually
- Downloads videos using ffmpeg by detecting m3u8 stream URLs
- Handles authentication automatically
- Saves login sessions for future use
- Configurable limits for number of posts to process and return
- Scroll detection to gather posts loaded dynamically
- Built with Playwright for reliable automation
- Organizes downloaded content by user ID and post ID

## Installation

1. Clone this repository
2. Install dependencies:
   ```
   npm install
   ```
   or
   ```
   yarn install
   ```
3. Ensure [ffmpeg](https://ffmpeg.org/download.html) is installed on your system and available in your PATH

## Usage

Run the script with:

```bash
npx ts-node src/test_twitter.ts [handle] [max_posts] [max_links] [download_content] [output_dir]
```

### Parameters

- `handle`: Twitter/X username to scrape (default: elonmusk)
- `max_posts`: Maximum number of posts to look through (set to 0 for unlimited). Default: 50
- `max_links`: Maximum number of links to return (set to 0 for unlimited). Default: 20
- `download_content`: Whether to download content (true/false). Default: true
- `output_dir`: Directory to save downloaded content. Default: ./output

### Examples

```bash
# Default: Scrape elonmusk, process up to 50 posts, return 20 links, download content
npx ts-node src/test_twitter.ts

# Scrape a specific user with default settings
npx ts-node src/test_twitter.ts TwitterDev

# Process all posts (unlimited), return all links, download content
npx ts-node src/test_twitter.ts elonmusk 0 0

# Process up to 100 posts, return up to 50 links, download content
npx ts-node src/test_twitter.ts jack 100 50

# Process 20 posts, return 10 links, skip content download
npx ts-node src/test_twitter.ts elonmusk 20 10 false

# Process 50 posts, return 20 links, download content to custom directory
npx ts-node src/test_twitter.ts elonmusk 50 20 true ./my_twitter_data
```

## Content Download

When content downloading is enabled, the tool will:

1. Create a directory structure based on user ID
2. Download and save tweet text, metadata, images, and videos
3. Organize files using the post ID as described below
4. **NEW**: Simple tweets (text and images only) are processed directly while scrolling, improving efficiency

### Processing Logic

The tool now intelligently processes tweets based on their content:

1. **Simple tweets** (containing only text and images):
   - Text and images are extracted directly from the timeline view
   - Content is saved immediately without visiting the individual tweet page
   - Significantly speeds up processing for basic tweets

2. **Complex tweets** (containing any of the following):
   - Videos or GIFs
   - Polls or interactive cards
   - "Show more" buttons or expandable content
   - These are processed by visiting the individual tweet page to access the full content

This hybrid approach maximizes efficiency while ensuring all content is properly captured.

### Output Structure

```
{output_dir}/{user_id}/
├── {post_id}.txt           # Tweet text and metadata
├── {post_id}.mp4           # Video from the tweet (if present)
├── {post_id}-1.jpg         # First image from the tweet
├── {post_id}-2.jpg         # Second image from the tweet
├── {post_id}-3.png         # Third image from the tweet (PNG format)
└── {post_id}-video-url.txt # Video URL info if ffmpeg download fails
```

### Video Download

The tool now supports downloading Twitter/X videos:

1. It monitors network traffic for m3u8 stream URLs while viewing a tweet
2. When a matching URL is found, it uses ffmpeg to download the video
3. Videos are saved as MP4 files with the post ID as the filename
4. If ffmpeg fails, the m3u8 URL is saved to a text file for manual download

**Requirements**: You must have ffmpeg installed on your system and available in your PATH for video downloading to work.

### Troubleshooting Video Playback Issues

If you see "The media could not be played" message in Chromium when trying to view videos:

1. **Codec Support**: Chromium may lack proprietary codecs needed for some video formats
   - For Mac: Consider using `brew install chromium --with-proprietary-codecs`
   - For Linux: Install chromium-codecs-ffmpeg-extra package
   - Alternatively, use a full Chrome installation which includes these codecs

2. **Using Alternative Commands**: If the default ffmpeg command fails, try:
   ```bash
   ffmpeg -headers "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/123.0.0.0" -i "YOUR_M3U8_URL" -c:v libx264 -c:a aac -strict experimental output.mp4
   ```

3. **Manual Download**: Check the saved `{post_id}-video-url.txt` file which contains the m3u8 URL and alternative ffmpeg commands to try

4. **Additional Media Info**: The tool saves network request logs to `{post_id}-network-requests.txt` which may contain useful information about other media resources

## Authentication

- On first run, a browser window will open and ask you to log in to Twitter/X
- Your session will be saved for future runs
- If your session expires, you'll be prompted to log in again

## How It Works

1. Opens a browser window to the specified Twitter/X profile
2. Handles authentication if needed
3. Extracts links from posts as they appear
4. Scrolls down to load more content
5. Continues until limits are reached or no more content is available
6. If content downloading is enabled:
   - Opens each tweet URL
   - Extracts text content and metadata
   - Downloads images
   - Monitors network traffic for video URLs
   - Uses ffmpeg to download videos
   - Saves everything in the organized directory structure

## License

MIT
