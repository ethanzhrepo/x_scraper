import { Page } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import { safeNavigate } from './utils';
import { execSync } from 'child_process';
import process from 'process';

/**
 * Extract user ID and post ID from tweet URL
 * @param url Tweet URL
 * @returns Object containing user ID and post ID
 */
export const extractIds = (url: string): { userId: string; postId: string } => {
  // Expected format: https://x.com/{userId}/status/{postId}
  const match = url.match(/https:\/\/x\.com\/([^\/]+)\/status\/(\d+)/);
  if (!match) {
    throw new Error(`Invalid tweet URL format: ${url}`);
  }
  
  return {
    userId: match[1],
    postId: match[2]
  };
};

/**
 * Ensure output directory exists
 * @param outputDir Base output directory
 * @param userId User ID for subdirectory
 * @returns Complete directory path
 */
export const ensureOutputDir = (outputDir: string, userId: string): string => {
  const userDir = path.join(outputDir, userId);
  
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  
  if (!fs.existsSync(userDir)) {
    fs.mkdirSync(userDir, { recursive: true });
  }
  
  return userDir;
};

/**
 * Download a file from URL
 * @param url File URL
 * @param outputPath Output file path
 * @returns Promise that resolves when file is downloaded
 */
export const downloadFile = (url: string, outputPath: string): Promise<void> => {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(outputPath);
    
    https.get(url, response => {
      // Handle redirects
      if (response.statusCode === 301 || response.statusCode === 302) {
        if (response.headers.location) {
          return downloadFile(response.headers.location, outputPath)
            .then(resolve)
            .catch(reject);
        }
        return reject(new Error(`Redirect without location for URL: ${url}`));
      }
      
      if (response.statusCode !== 200) {
        return reject(new Error(`Failed to download file, status code: ${response.statusCode}, URL: ${url}`));
      }
      
      response.pipe(file);
      
      file.on('finish', () => {
        file.close();
        console.log(`Downloaded: ${outputPath}`);
        resolve();
      });
      
      file.on('error', err => {
        fs.unlink(outputPath, () => {}); // Delete the file if there was an error
        reject(err);
      });
    }).on('error', err => {
      fs.unlink(outputPath, () => {}); // Delete the file if there was an error
      reject(err);
    });
  });
};

/**
 * Extract and save tweet text content and author's replies
 * @param page Playwright page
 * @param outputPath Output file path
 */
export const extractAndSaveText = async (page: Page, outputPath: string): Promise<void> => {
  try {
    // Wait for the article content to load
    await page.waitForSelector('article[data-testid="tweet"]', { timeout: 30000 });
    
    // Extract tweet text
    const tweetText = await page.$eval('article[data-testid="tweet"] div[data-testid="tweetText"]', 
      element => element.textContent || 'No text content'
    ).catch(() => 'No text content available');
    
    // Extract user info
    const userName = await page.$eval('article[data-testid="tweet"] div[data-testid="User-Name"]', 
      element => element.textContent || 'Unknown user'
    ).catch(() => 'Unknown user');
    
    // Extract timestamp
    const timestamp = await page.$eval('article[data-testid="tweet"] time', 
      element => element.getAttribute('datetime') || 'Unknown time'
    ).catch(() => 'Unknown time');
    
    // Get user handle/screen name for identifying author's replies
    const authorHandle = await page.$eval('article[data-testid="tweet"] div[data-testid="User-Name"] a[role="link"]', 
      element => element.textContent?.trim().replace('@', '') || ''
    ).catch(() => '');
    
    // Format the main content
    let content = `User: ${userName}\nTime: ${timestamp}\n\nContent:\n${tweetText}\n`;
    
    // Try to load more replies
    try {
      // Scroll down to load more replies
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(2000);
      
      // Try to click "Show more replies" buttons
      const showMoreButtons = await page.$$('div[role="button"][data-testid="cellInnerDiv"] span:has-text("Show more replies")');
      for (const button of showMoreButtons.slice(0, 3)) { // Limit to first few "Show more" buttons
        await button.click().catch(() => {});
        await page.waitForTimeout(1500);
      }
    } catch (error) {
      console.log('Could not load additional replies, continuing with visible ones');
    }
    
    // Extract author's replies in the thread
    const authorReplies: string[] = [];
    
    // Wait a moment for replies to load
    await page.waitForTimeout(2000);
    
    // Find all tweets in the thread
    const replyTweets = await page.$$('article[data-testid="tweet"]');
    
    // Skip the first one as it's the main tweet
    for (let i = 1; i < replyTweets.length; i++) {
      const tweet = replyTweets[i];
      
      try {
        // Check if this reply is from the original author
        const replyUserHandle = await tweet.$eval('div[data-testid="User-Name"] a[role="link"]', 
          element => element.textContent?.trim().replace('@', '') || ''
        );
        
        // Only collect replies from the original author
        if (replyUserHandle === authorHandle) {
          const replyText = await tweet.$eval('div[data-testid="tweetText"]', 
            element => element.textContent || ''
          );
          
          const replyTime = await tweet.$eval('time', 
            element => element.getAttribute('datetime') || ''
          );
          
          authorReplies.push(`Time: ${replyTime}\nContent: ${replyText}`);
        }
      } catch (error) {
        // Skip any problematic tweets
        continue;
      }
    }
    
    // Add author's replies to the content if any were found
    if (authorReplies.length > 0) {
      content += `\n\nAuthor's Replies in Thread (${authorReplies.length}):\n`;
      content += authorReplies.map((reply, index) => `--- Reply ${index + 1} ---\n${reply}`).join('\n\n');
    }
    
    // Save to file
    fs.writeFileSync(outputPath, content, 'utf8');
    console.log(`Saved tweet text and ${authorReplies.length} author replies to: ${outputPath}`);
  } catch (error: any) {
    console.error(`Error extracting tweet text: ${error.message}`);
    // Save error info to file
    fs.writeFileSync(outputPath, `Failed to extract text: ${error.message}`, 'utf8');
  }
};

/**
 * Extract and download images from tweet
 * @param page Playwright page
 * @param postId Post ID for filename
 * @param outputDir Output directory
 */
export const extractAndDownloadImages = async (page: Page, postId: string, outputDir: string): Promise<string[]> => {
  const downloadedFiles: string[] = [];
  
  try {
    // Wait for images to load
    await page.waitForSelector('article[data-testid="tweet"]', { timeout: 30000 });
    
    // Look for image containers
    const imageUrls = await page.$$eval('article[data-testid="tweet"] img[src*="https://pbs.twimg.com/media/"]', 
      elements => elements.map(el => (el as HTMLImageElement).src)
    ).catch(() => []);
    
    // Filter out any profile pictures or icons
    const filteredUrls = imageUrls.filter(url => 
      url.includes('/media/') && 
      !url.includes('profile_images') && 
      !url.includes('profile_banners')
    );
    
    // Download each image
    for (let i = 0; i < filteredUrls.length; i++) {
      const url = filteredUrls[i];
      
      // Get file extension
      const extension = url.includes('.jpg') || url.includes('.jpeg') ? 'jpg' : 
                        url.includes('.png') ? 'png' : 
                        url.includes('.gif') ? 'gif' : 'jpg';
      
      const outputPath = path.join(outputDir, `${postId}-${i+1}.${extension}`);
      await downloadFile(url, outputPath);
      downloadedFiles.push(outputPath);
    }
    
    console.log(`Downloaded ${downloadedFiles.length} images for post ${postId}`);
  } catch (error: any) {
    console.error(`Error downloading images: ${error.message}`);
  }
  
  return downloadedFiles;
};

/**
 * Extract and download videos from tweet
 * @param page Playwright page
 * @param postId Post ID for filename
 * @param outputDir Output directory
 */
export const extractAndDownloadVideos = async (page: Page, postId: string, outputDir: string): Promise<string[]> => {
  const downloadedFiles: string[] = [];
  
  try {
    // Wait for article to load
    await page.waitForSelector('article[data-testid="tweet"]', { timeout: 30000 });
    
    // Check if the page has a video player
    const hasVideo = await page.$('article[data-testid="tweet"] div[data-testid="videoPlayer"]');
    
    if (hasVideo) {
      console.log(`Video detected in post ${postId}, but video downloading is temporarily disabled.`);
      
      // Create output path for the video (not used now, but keeping for reference)
      const outputPath = path.join(outputDir, `${postId}.mp4`);
      
      // Instead of downloading video, just take a screenshot and save info
      try {
        const screenshotPath = path.join(outputDir, `${postId}-video-player.png`);
        await page.screenshot({ 
          path: screenshotPath,
          clip: await page.evaluate((selector) => {
            const element = document.querySelector(selector);
            if (!element) return undefined;
            const {x, y, width, height} = element.getBoundingClientRect();
            return {x, y, width, height};
          }, 'article[data-testid="tweet"] div[data-testid="videoPlayer"]')
        });
        console.log(`Saved screenshot of video player to ${screenshotPath}`);
        downloadedFiles.push(screenshotPath);
      } catch (screenshotError: any) {
        console.log(`Could not take screenshot: ${screenshotError.message}`);
      }
      
      // Save info about the disabled functionality
      const infoPath = path.join(outputDir, `${postId}-video-info.txt`);
      fs.writeFileSync(
        infoPath,
        'Video detected but download functionality is temporarily disabled.\n' +
        'To enable video downloading, edit the extractAndDownloadVideos function in src/content_downloader.ts'
      );
      
      console.log(`Saved video info to ${infoPath}`);
    } else {
      console.log(`No video detected in post ${postId}`);
    }
  } catch (error: any) {
    console.error(`Error extracting video: ${error.message}`);
    
    // Save error info
    fs.writeFileSync(
      path.join(outputDir, `${postId}-video-error.txt`),
      `Failed to extract video: ${error.message}`
    );
  }
  
  return downloadedFiles;
};

/**
 * Set up request blocking for unnecessary endpoints to reduce rate limiting
 * @param page Playwright page
 */
export const setupRequestBlocking = async (page: Page): Promise<void> => {
  // List of API endpoints to block - these are not needed for basic content extraction
  const endpointsToBlock = [
    // Fleets API (Stories feature that generates a lot of requests)
    '**/i/api/fleets/v1/fleetline',
    '**/i/api/fleets/**',
    
    // Notification and recommendation APIs that we don't need
    '**/i/api/2/notifications/**',
    '**/i/api/1.1/notifications/**',
    '**/i/api/2/badge_count.json',
    '**/i/api/graphql/*/HomeLatestTimeline',
    '**/i/api/graphql/*/HomeTimeline', 
    '**/i/api/graphql/*/UserActions',
    '**/i/api/graphql/*/ProfileUsersPod',
    '**/i/api/graphql/*/UserTweets',
    '**/i/api/graphql/*/User',
    '**/i/api/graphql/*/UsersByRestIds',
    //

    '**/i/api/graphql/*/Viewer*',
    // https://x.com/i/api/graphql/I_tJ_DO6WLqG0em8EQsVVg/isEligibleForAnalyticsUpsellQuery?variables=%7B%7D
    '**/i/api/graphql/*/isEligibleForAnalyticsUpsellQuery?variables=%7B%7D',
    '**/i/api/graphql/*/isEligibleForAnalyticsUpsellQuery*',
    // https://x.com/i/api/1.1/keyregistry/register
    '**/i/api/1.1/keyregistry/register',
    '**/i/api/1.1/keyregistry/register*',
    // Other miscellaneous APIs
    '**/i/api/1.1/jot/client_event.json',
    '**/i/api/1.1/statuses/update.json',
    '**/i/api/graphql/*/Favoriters',
    '**/i/api/graphql/*/Retweeters',
    '**/i/api/2/guide.json',
    '**/i/api/1.1/geo/**'
  ];

  // Set up route blocking for each endpoint
  for (const endpoint of endpointsToBlock) {
    await page.route(endpoint, route => {
      const url = route.request().url();
      const shortUrl = url.length > 100 ? url.substring(0, 100) + '...' : url;
      console.log(`⛔ Blocked non-essential request: ${shortUrl}`);
      route.abort();
    });
  }
  
  console.log('✅ Request blocking set up for non-essential Twitter API endpoints');
};

/**
 * Process a single tweet URL to download content
 * @param page Playwright page
 * @param tweetUrl URL of the tweet
 * @param outputDir Base output directory
 * @returns Promise<boolean> True if processed, false if skipped
 */
export const processTweetContent = async (page: Page, tweetUrl: string, outputDir: string): Promise<boolean> => {
  try {
    // Extract user ID and post ID from the URL
    const { userId, postId } = extractIds(tweetUrl);
    
    // Ensure the output directory exists
    const userDir = ensureOutputDir(outputDir, userId);
    
    console.log(`Processing tweet: ${tweetUrl}`);
    console.log(`User ID: ${userId}, Post ID: ${postId}`);
    
    // Check if this tweet has already been processed
    const textFilePath = path.join(userDir, `${postId}.txt`);
    const imagePattern = path.join(userDir, `${postId}-*.`); // Match any image file with this postId
    const videoInfoPath = path.join(userDir, `${postId}-video-info.txt`);
    const videoErrorPath = path.join(userDir, `${postId}-video-error.txt`);
    const videoPath = path.join(userDir, `${postId}.mp4`);
    const screenshotPath = path.join(userDir, `${postId}-video-player.png`);
    
    // Check for existence of any related files
    const hasTextFile = fs.existsSync(textFilePath);
    
    // Check for any image files with this postId pattern
    const hasImageFiles = fs.readdirSync(userDir).some(file => 
      file.startsWith(`${postId}-`) && 
      (file.endsWith('.jpg') || file.endsWith('.png') || file.endsWith('.gif'))
    );
    
    const hasVideoFile = fs.existsSync(videoPath);
    const hasVideoInfo = fs.existsSync(videoInfoPath);
    const hasVideoError = fs.existsSync(videoErrorPath);
    const hasScreenshot = fs.existsSync(screenshotPath);
    
    // If any related files exist, skip this tweet
    if (hasTextFile || hasImageFiles || hasVideoFile || hasVideoInfo || hasVideoError || hasScreenshot) {
      console.log(`Skipping tweet ${postId} - already processed (found existing files in ${userDir})`);
      if (hasTextFile) console.log(`- Found text file: ${textFilePath}`);
      if (hasImageFiles) console.log(`- Found image files with pattern: ${postId}-*`);
      if (hasVideoFile) console.log(`- Found video file: ${videoPath}`);
      if (hasVideoInfo) console.log(`- Found video info: ${videoInfoPath}`);
      if (hasVideoError) console.log(`- Found video error: ${videoErrorPath}`);
      if (hasScreenshot) console.log(`- Found screenshot: ${screenshotPath}`);
      
      return false; // Indicate that processing was skipped
    }
    
    // Monitor for 429 responses during navigation but don't interrupt (just log)
    page.on('response', async response => {
      if (response.status() === 429) {
        console.warn('\n⚠️ WARNING: Rate limit response (HTTP 429) detected but continuing anyway');
        console.warn('⚠️ Twitter may limit your account if too many 429 responses are received');
        console.warn(`⚠️ Resource is ${response.url()}`);

        // Log the response headers for debugging
        const headers = response.headers();
        if (headers['x-rate-limit-remaining']) {
          console.warn(`⚠️ Rate limit remaining: ${headers['x-rate-limit-remaining']}`);
        }
        if (headers['x-rate-limit-reset']) {
          const resetTime = new Date(parseInt(headers['x-rate-limit-reset']) * 1000);
          console.warn(`⚠️ Rate limit resets at: ${resetTime.toLocaleString()}`);
        }

        // If rate limited, wait until reset time
        if (headers['x-rate-limit-reset']) {
          const resetTimestamp = parseInt(headers['x-rate-limit-reset']) * 1000;
          const waitMs = resetTimestamp - Date.now();
          
          if (waitMs > 0) {
            console.warn(`⚠️ Waiting ${Math.ceil(waitMs/1000)} seconds for rate limit to reset...`);
            await page.waitForTimeout(waitMs);
            // Refresh the page after waiting for rate limit
            await page.reload({ waitUntil: 'domcontentloaded' });
            await page.waitForTimeout(2000); // Additional wait after reload
            console.warn('⚠️ Rate limit wait complete, continuing...');
          }
        }
      }
    });
    
    // Navigate to the tweet using our safe navigation utility
    await safeNavigate(page, tweetUrl, `Tweet ${postId}`);
    
    // Extract and save text content
    await extractAndSaveText(page, textFilePath);
    
    // Extract and download images
    await extractAndDownloadImages(page, postId, userDir);
    
    // Extract and download videos
    await extractAndDownloadVideos(page, postId, userDir);
    
    console.log(`Completed processing tweet: ${tweetUrl}`);
    return true; // Indicate that processing was completed
  } catch (error: any) {
    // Check if this is a rate limit error (429) but continue anyway
    if (error.code === 429 || error.message?.includes('429')) {
      console.warn('\n\n==================================================');
      console.warn('⚠️ RATE LIMIT DETECTED: Twitter has rate limited your requests (HTTP 429)');
      console.warn('⚠️ Continuing processing despite rate limit (as requested)');
      console.warn('⚠️ This may lead to account limitations if continued for too long');
      console.warn('==================================================\n\n');
      
      // Save empty placeholder files to mark this tweet as at least attempted
      const { userId, postId } = extractIds(tweetUrl);
      const userDir = ensureOutputDir(outputDir, userId);
      
      const errorFilePath = path.join(userDir, `${postId}-rate-limited.txt`);
      fs.writeFileSync(
        errorFilePath,
        `Rate limited when trying to process tweet: ${tweetUrl}\nTime: ${new Date().toISOString()}`
      );
      
      return false; // Indicate processing failed due to rate limit
    }
    
    console.error(`Error processing tweet ${tweetUrl}: ${error.message}`);
    return false; // Indicate that processing failed
  }
};

/**
 * Process multiple tweet URLs to download content
 * @param tweetUrls List of tweet URLs
 * @param outputDir Base output directory
 * @param existingPage Optional existing page to reuse
 * @param sleepMs Optional time to sleep between requests in milliseconds (default: 5000ms)
 */
export const processMultipleTweets = async (tweetUrls: string[], outputDir: string, existingPage?: Page, sleepMs: number = 5000): Promise<void> => {
  let page: Page | undefined;
  let shouldClosePage = false;
  
  // Stats tracking
  let processedCount = 0;
  let skippedCount = 0;
  let rateLimitedCount = 0;
  const totalTweets = tweetUrls.length;
  
  /**
   * Display progress information
   * @param current Current index (0-based)
   * @param total Total number of items
   * @param additionalInfo Additional information to display
   */
  const showProgress = (current: number, total: number, additionalInfo: string = '') => {
    const percent = Math.floor((current / total) * 100);
    const progressBarWidth = 30;
    const filledWidth = Math.floor((current / total) * progressBarWidth);
    const emptyWidth = progressBarWidth - filledWidth;
    
    const progressBar = '[' + '='.repeat(filledWidth) + ' '.repeat(emptyWidth) + ']';
    const progressMessage = `Progress: ${current}/${total} ${progressBar} ${percent}% ${additionalInfo}`;
    
    // Create a line with enough spaces to cover any previous longer message
    const clearLine = ' '.repeat(100); 
    process.stdout.write(`\r${clearLine}`);
    process.stdout.write(`\r${progressMessage}`);
  };
  
  try {
    if (existingPage) {
      // Reuse the existing page
      console.log('Reusing existing browser page for processing tweets');
      page = existingPage;
      
      // Set up request blocking even on existing page
      await setupRequestBlocking(page);
    } else {
      // Import dynamically to avoid circular dependencies
      const { get_browser_with_session } = await import('./login');
      
      // Get a browser session
      const { browser, context } = await get_browser_with_session();
      
      // Create a new page only if we weren't given one
      page = await context.newPage();
      shouldClosePage = true; // We should close this page when done
      
      // Set up request blocking
      await setupRequestBlocking(page);
    }
    
    // Make sure page is defined at this point
    if (!page) {
      throw new Error('Failed to initialize page');
    }
    
    console.log(`Starting to process ${totalTweets} tweets...`);
    console.log(`Sleep interval between requests: ${sleepMs}ms`);
    console.log(`NOTE: Rate limit detection (429) is disabled - will not interrupt processing`);
    
    // Initial progress display
    showProgress(0, totalTweets, 'Starting...');
    
    for (let i = 0; i < totalTweets; i++) {
      const url = tweetUrls[i];
      const currentCount = i + 1;
      
      // Update progress with current tweet info
      showProgress(currentCount, totalTweets, `Processing: ${url}`);
      
      try {
        // Process tweet and get result (true if processed, false if skipped or failed)
        const wasProcessed = await processTweetContent(page, url, outputDir);
        
        if (wasProcessed) {
          processedCount++;
          // Update progress with success info
          showProgress(currentCount, totalTweets, `✓ Successfully processed: ${url}`);
        } else {
          // Check if it was skipped due to existing files or failed due to an error
          // The error case is logged inside processTweetContent
          skippedCount++;
          // Update progress with skipped info
          showProgress(currentCount, totalTweets, `⏩ Skipped: ${url}`);
        }
        
        // Wait between requests to avoid rate limiting (but only if we're not at the end,
        // and only if the tweet was actually processed)
        if (i < totalTweets - 1 && wasProcessed) {
          // Update progress with waiting info
          showProgress(currentCount, totalTweets, `⏳ Waiting ${sleepMs}ms before next tweet...`);
          await page.waitForTimeout(sleepMs);
        }
      } catch (error: any) {
        // For all errors, just log and continue
        console.log(''); // New line after progress bar
        console.error(`Error processing tweet ${url}: ${error.message}`);
        
        // Count rate limited tweets
        if (error.code === 429 || error.message?.includes('429')) {
          rateLimitedCount++;
          showProgress(currentCount, totalTweets, `⚠️ Rate limited but continuing: ${url}`);
        } else {
          skippedCount++;
          showProgress(currentCount, totalTweets, `⚠️ Error occurred: ${url}`);
        }
        
        // Still wait before the next tweet to avoid cascading errors
        if (i < totalTweets - 1) {
          // Update progress with waiting info
          showProgress(currentCount, totalTweets, `⏳ Waiting ${sleepMs}ms before next tweet...`);
          await page.waitForTimeout(sleepMs);
        }
      }
    }
    
    console.log(''); // New line after progress bar for summary
    
    // Print summary statistics
    console.log(`\nProcessing summary:`);
    console.log(`- Total tweets: ${totalTweets}`);
    console.log(`- Successfully processed: ${processedCount} (${Math.floor((processedCount / totalTweets) * 100)}%)`);
    console.log(`- Skipped or failed: ${skippedCount} (${Math.floor((skippedCount / totalTweets) * 100)}%)`);
    if (rateLimitedCount > 0) {
      console.log(`- Rate limited tweets: ${rateLimitedCount} (${Math.floor((rateLimitedCount / totalTweets) * 100)}%)`);
      console.log(`- ⚠️ Rate limits were detected but processing continued as requested`);
      console.log(`- ⚠️ You may want to wait before attempting more downloads`);
    }
    console.log(`\nCompleted processing all ${totalTweets} tweets.`);
  } catch (error: any) {
    console.log(''); // New line after progress bar
    console.error(`Error in batch processing: ${error.message}`);
  } finally {
    // Only close the page if we created it and it exists
    if (shouldClosePage && page) {
      await page.close();
      console.log('Page closed, but browser remains active for future operations.');
    }
  }
};
