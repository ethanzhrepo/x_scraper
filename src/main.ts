import { chromium, Page } from 'playwright';
import { get_browser_with_session } from './login';
import { safeNavigate } from './utils';
import { processMultipleTweets } from './content_downloader';

/**
 * Find tweet links from a Twitter/X profile
 * @param initial_url - URL of the Twitter profile to scrape
 * @param max_id - Maximum number of posts to scroll through (0 for unlimited)
 * @param limit - Maximum number of links to return (0 for unlimited)
 * @param download_content - Whether to download content (text, images, videos)
 * @param output_dir - Directory to save downloaded content
 * @returns Array of tweet URLs
 */
export const find_links = async (
  initial_url: string, 
  max_id: number, 
  limit: number = 0,
  download_content: boolean = false,
  output_dir: string = './output'
): Promise<string[]> => {
  // Get browser with session (will handle login if needed)
  const { browser, context } = await get_browser_with_session();
  const page = await context.newPage();

  try {
    // Use safer navigation method
    await safeNavigate(page, initial_url, 'Twitter profile');
    
    // Wait for articles to load
    try {
      // More robust waiting for content with retries
      console.log('Waiting for articles to appear...');
      const RETRY_DELAY = 2000;
      const MAX_RETRIES = 5;
      
      for (let i = 0; i < MAX_RETRIES; i++) {
        try {
          await page.waitForSelector('article', { timeout: 15000 });
          console.log('Articles found!');
          break;
        } catch (waitError) {
          if (i === MAX_RETRIES - 1) {
            throw new Error('Could not find any articles after multiple attempts');
          }
          console.log(`No articles found yet, retrying in ${RETRY_DELAY / 1000} seconds... (${i + 1}/${MAX_RETRIES})`);
          await page.waitForTimeout(RETRY_DELAY);
          
          // Try scrolling a bit to trigger content loading
          await page.evaluate(() => window.scrollBy(0, 300));
        }
      }
    } catch (articleError: any) {
      console.error('Error waiting for articles:', articleError.message);
      
      // Take a screenshot to help debugging
      try {
        const screenshotPath = `error-screenshot-${Date.now()}.png`;
        await page.screenshot({ path: screenshotPath });
        console.log(`Page screenshot saved to ${screenshotPath}`);
      } catch (screenshotError: any) {
        console.error('Failed to take error screenshot:', screenshotError.message);
      }
      
      throw new Error('Could not load Twitter content. The page might be unavailable or the account may not exist.');
    }
    
    // Set to store unique post links
    const uniqueLinks = new Set<string>();
    let foundIds = 0;
    // Set to track which tweets have already been processed directly
    const processedTweets = new Set<string>();
    
    // Function to extract links
    const extractLinks = async () => {
      const linksAndContent = await page.$$eval('article', (articles) => {
        const results = [];
        
        for (const article of articles) {
          // Get the tweet link
          const linkElement = article.querySelector('a:has(time)');
          const href = linkElement ? linkElement.getAttribute('href') : null;
          
          if (href) {
            // Extract text content
            const textElement = article.querySelector('[data-testid="tweetText"]');
            const textContent = textElement ? textElement.textContent : '';
            
            // Extract image URLs
            const imageElements = article.querySelectorAll('img[src*="pbs.twimg.com/media"]');
            const imageUrls = Array.from(imageElements).map(img => (img as HTMLImageElement).src);
            
            // Check if this is a simple tweet (just text and images, no embedded videos, polls, etc.)
            const hasVideo = article.querySelector('[data-testid="videoPlayer"]') !== null;
            const hasPoll = article.querySelector('[data-testid="cardPoll"]') !== null;
            const hasCard = article.querySelector('[data-testid="card.wrapper"]') !== null;
            
            // Check if tweet has "Show more" or similar expandable content
            const hasShowMore = 
              // 常见的"显示更多"按钮
              article.querySelector('[role="button"][tabindex="0"]:not([aria-label])') !== null || 
              // 带有展开文本的span元素
              article.querySelector('span[dir="auto"]:not([data-testid])') !== null ||
              // 含有 "Show more" 文本的元素
              Array.from(article.querySelectorAll('span')).some(span => 
                span.textContent && (
                  span.textContent.includes('Show more') || 
                  span.textContent.includes('显示更多') ||
                  span.textContent.includes('查看更多')
                )
              ) ||
              // 检查可能的链接展开按钮
              article.querySelector('a[role="link"][aria-expanded="false"]') !== null;
            
            const isSimpleTweet = !hasVideo && !hasPoll && !hasCard && !hasShowMore;
            
            results.push({
              href,
              isSimpleTweet,
              content: {
                text: textContent || '',  // Ensure text is never null
                imageUrls
              }
            });
          }
        }
        
        return results;
      });
      
      // Process the results
      for (const item of linksAndContent) {
        if (item.href && !uniqueLinks.has(item.href)) {
          uniqueLinks.add(item.href);
          console.log(`Found post: https://x.com${item.href}`);
          foundIds++;
          
          // If content download is enabled and it's a simple tweet, save the content directly
          if (download_content && item.isSimpleTweet) {
            console.log(`Directly processing simple tweet: https://x.com${item.href}`);
            await saveSimpleContent(item.href, item.content, output_dir);
            processedTweets.add(item.href);
          } else if (download_content) {
            console.log(`Tweet at https://x.com${item.href} will be processed by processMultipleTweets (contains complex content)`);
          }
          
          // Check if we've reached the limit of links to collect
          if (limit > 0 && uniqueLinks.size >= limit) {
            console.log(`Reached link limit of ${limit}. Stopping collection.`);
            return -1; // Special return value to indicate limit reached
          }
        }
      }
      
      return uniqueLinks.size;
    };
    
    // Initial extraction
    let extractResult = await extractLinks();
    if (extractResult === -1) {
      // Limit reached during initial extraction
      console.log(`Scraping complete. Found ${uniqueLinks.size} unique posts (limit reached).`);
      return Array.from(uniqueLinks).map(href => `https://x.com${href}`);
    }
    
    // Scroll and extract until max_id is reached or no more content
    let previousSize = 0;
    let sameCountIterations = 0;
    let reachedBottom = false;
    
    while (!reachedBottom && (max_id === 0 || foundIds < max_id)) {
      // Scroll down
      await page.evaluate(() => {
        window.scrollBy(0, window.innerHeight);
      });
      
      // Wait for potential new content to load
      await page.waitForTimeout(1500);
      
      const currentSize = await extractLinks();
      
      // Check if limit was reached during extraction
      if (currentSize === -1) {
        break;
      }
      
      // Check if we've reached the bottom (no new links after several scrolls)
      if (currentSize === previousSize) {
        sameCountIterations++;
        if (sameCountIterations >= 3) {
          console.log('Reached bottom of the page or no more new content.');
          reachedBottom = true;
        }
      } else {
        sameCountIterations = 0;
        previousSize = currentSize;
      }
    }
    
    // Convert set to array of complete URLs
    const resultLinks = Array.from(uniqueLinks).map(href => `https://x.com${href}`);
    
    // Apply limit if needed
    let finalLinks = resultLinks;
    if (limit > 0 && resultLinks.length > limit) {
      console.log(`Scraping complete. Found ${uniqueLinks.size} unique posts, returning first ${limit}.`);
      finalLinks = resultLinks.slice(0, limit);
    } else {
      console.log(`Scraping complete. Found ${uniqueLinks.size} unique posts.`);
    }
    
    // Download content if requested
    if (download_content && finalLinks.length > 0) {
      console.log(`Starting to download content for ${finalLinks.length} tweets...`);
      
      // Filter out tweets that were already processed directly
      const remainingLinks = finalLinks.filter(link => {
        const href = link.replace('https://x.com', '');
        return !processedTweets.has(href);
      });
      
      if (remainingLinks.length > 0) {
        console.log(`Processing ${remainingLinks.length} tweets that need additional content extraction:`);
        console.log(`These tweets contain videos, polls, cards, or expandable content that requires detailed processing.`);
        await processMultipleTweets(remainingLinks, output_dir, page);
      } else {
        console.log('All tweets were already processed directly as they contained only text and images.');
      }
      
      // Navigate back to the profile page to restore state
      console.log(`Navigating back to profile: ${initial_url}`);
      await safeNavigate(page, initial_url, 'Twitter profile');
    }
    
    return finalLinks;
  } catch (error) {
    console.error('Error during scraping:', error);
    throw error;
  } finally {
    // Close only the page, not the browser or context
    await page.close();
    console.log('Page closed, but browser session remains active.');
  }
};

// Function to save simple content directly
const saveSimpleContent = async (href: string, content: { text: string, imageUrls: string[] }, outputDir: string) => {
  try {
    const fs = require('fs');
    const path = require('path');
    const axios = require('axios');
    
    // Extract user ID and post ID from href
    // Expected format: /userId/status/postId
    const parts = href.split('/');
    if (parts.length < 4) {
      throw new Error(`Invalid tweet URL format: ${href}`);
    }
    
    const userId = parts[1];
    const postId = parts[3];
    
    // Create user directory if it doesn't exist
    const userDir = path.join(outputDir, userId);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
    if (!fs.existsSync(userDir)) {
      fs.mkdirSync(userDir, { recursive: true });
    }
    
    // Save text content
    if (content.text) {
      const textPath = path.join(userDir, `${postId}.txt`);
      fs.writeFileSync(textPath, content.text);
      console.log(`Saved text for tweet ${userId}/${postId}`);
    }
    
    // Save images
    if (content.imageUrls && content.imageUrls.length > 0) {
      for (let i = 0; i < content.imageUrls.length; i++) {
        const imageUrl = content.imageUrls[i];
        const imageResponse = await axios.get(imageUrl, { responseType: 'arraybuffer' });
        const imageExtension = imageUrl.includes('.png') ? 'png' : 'jpg';
        const imagePath = path.join(userDir, `${postId}-${i+1}.${imageExtension}`);
        fs.writeFileSync(imagePath, imageResponse.data);
        console.log(`Saved image ${i+1} for tweet ${userId}/${postId}`);
      }
    }
    
    return true;
  } catch (error) {
    console.error(`Error saving content for ${href}:`, error);
    return false;
  }
};
