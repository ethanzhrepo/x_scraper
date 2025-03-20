import { chromium, BrowserContext, Page, Browser } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import { execSync } from 'child_process';

const SESSION_FILE_PATH = path.join(__dirname, '../twitter_session.json');

// Global variable to store browser and context
let globalBrowser: Browser | null = null;
let globalContext: BrowserContext | null = null;

/**
 * Check if a valid Twitter/X login session exists
 * @returns True if session file exists, false otherwise
 */
export const check_login = async (): Promise<boolean> => {
  try {
    // Check if session file exists and is valid (not expired)
    if (fs.existsSync(SESSION_FILE_PATH)) {
      // Check file age to ensure it's not too old
      const stats = fs.statSync(SESSION_FILE_PATH);
      const fileAgeDays = (Date.now() - stats.mtimeMs) / (1000 * 60 * 60 * 24);
      
      // Consider session valid if less than 7 days old (降低到7天，确保更频繁刷新会话)
      if (fileAgeDays < 7) {
        console.log('Login session found and is valid.');
        return true;
      } else {
        console.log('Login session found but is too old (over 7 days). Will need to login again.');
        return false;
      }
    }
    console.log('No login session found.');
    return false;
  } catch (error) {
    console.error('Error checking login session:', error);
    return false;
  }
};

/**
 * Check if user is logged in to Twitter/X
 * @param page - Playwright page object
 * @returns True if logged in, false otherwise
 */
export const is_logged_in = async (page: Page): Promise<boolean> => {
  try {
    // Check for login state by looking for typical elements
    
    // Check for login button or sign up elements (indicates not logged in)
    const loginElements = await page.$('a[href="/i/flow/login"]') || 
                          await page.$('a[href="/i/flow/signup"]') ||
                          await page.$('a[data-testid="login"]') ||
                          await page.$('a[data-testid="signup"]');
    
    if (loginElements) {
      console.log('Not logged in to Twitter/X');
      return false;
    }
    
    // Check for elements that are only present when logged in
    const loggedInElement = await page.$('a[aria-label="Profile"]') || 
                           await page.$('a[data-testid="AppTabBar_Profile_Link"]') ||
                           await page.$('a[data-testid="SideNav_NewTweet_Button"]') ||
                           await page.$('a[href="/compose/tweet"]');
    
    if (loggedInElement) {
      console.log('Already logged in to Twitter/X');
      return true;
    }
    
    // If we can't determine for sure, check if we can find post elements
    // which typically only appear when logged in
    const timelineElements = await page.$$('article[data-testid="tweet"]');
    if (timelineElements && timelineElements.length > 0) {
      console.log('Logged in state detected by timeline content');
      return true;
    }
    
    console.log('Could not determine login state, assuming not logged in');
    return false;
  } catch (error) {
    console.error('Error checking if logged in:', error);
    return false;
  }
};

/**
 * Navigate to a URL with improved error handling
 * @param page - Playwright page
 * @param url - URL to navigate to
 * @param description - Description for logging
 */
const safeNavigate = async (page: Page, url: string, description: string) => {
  try {
    console.log(`Navigating to ${url} (${description})...`);
    await page.goto(url, { 
      waitUntil: 'domcontentloaded',
      timeout: 60000 // 60 second timeout
    });
    
    // Wait for body to be visible
    await page.waitForSelector('body', { 
      state: 'visible', 
      timeout: 30000 
    });
    
    console.log(`Successfully loaded ${description}`);
    return true;
  } catch (error: any) {
    console.warn(`Navigation warning for ${description}:`, error.message);
    console.log('Continuing with current page state...');
    return false;
  }
};

/**
 * Login to Twitter/X and save the session
 * @returns Browser context with active session
 */
export const login = async (): Promise<{ browser: Browser, context: BrowserContext }> => {
  // If we already have an active browser session, return it
  if (globalBrowser && globalContext) {
    console.log('Using existing browser session');
    return { browser: globalBrowser, context: globalContext };
  }
  
  // Launch browser with enhanced media options
  const browser = await chromium.launch({
    channel: 'chrome', // 使用已安装的Chrome而非Playwright自带Chromium
    headless: false,
    args: [
      '--autoplay-policy=no-user-gesture-required',
      '--disable-web-security',
      '--use-fake-ui-for-media-stream',
      '--enable-usermedia-screen-capturing',
      '--allow-http-screen-capture',
      '--use-fake-device-for-media-stream',
      '--enable-features=NetworkService,NetworkServiceInProcess',
      '--allow-running-insecure-content',
      '--disable-features=IsolateOrigins,site-per-process',
      '--enable-usermedia-screen-capturing',
      '--disable-gpu-sandbox',
      '--enable-gpu-rasterization',
      '--ignore-certificate-errors',
      '--enable-features=VaapiVideoDecoder',
      '--enable-features=Vulkan',
      '--no-sandbox',
      '--no-first-run',
      '--no-default-browser-check',
      '--no-zygote',
      '--use-gl=desktop',
      '--use-vulkan=native',
      '--enable-logging',
      '--disable-backgrounding-occluded-windows',
      '--enable-media-stream',
      '--enable-webgl',
      // Additional parameters for improved stability
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-pings',
      '--dns-prefetch-disable',
      // Extended cookie lifetime
      '--persistent-cookie-lifetime=30'
    ],
    chromiumSandbox: false,
    ignoreDefaultArgs: ['--mute-audio']
  });
  if (!browser) {
    throw new Error('Failed to launch browser');
  }
  
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
    permissions: ['microphone', 'camera', 'geolocation'],
    ignoreHTTPSErrors: true,
    bypassCSP: true,
    acceptDownloads: true,
    javaScriptEnabled: true,
    hasTouch: false,
    isMobile: false,
    // Set a longer-lived storage state
    storageState: fs.existsSync(SESSION_FILE_PATH) ? 
      JSON.parse(fs.readFileSync(SESSION_FILE_PATH, 'utf8')) : undefined
  });
  
  // Store globally
  globalBrowser = browser;
  globalContext = context;
  
  // Open Twitter login page
  const page = await context.newPage();
  
  // Use safer navigation approach
  await safeNavigate(page, 'https://x.com', 'Twitter homepage');
  
  // Check if already logged in
  let loggedIn = await is_logged_in(page);
  
  if (!loggedIn) {
    // Navigate to login page
    await safeNavigate(page, 'https://x.com/i/flow/login', 'login page');
    
    console.log('Please log in to Twitter/X in the browser window...');
    
    // Wait for login to complete - check every 5 seconds if user has logged in
    const maxAttempts = 60; // 5 minutes timeout
    let attempts = 0;
    
    while (!loggedIn && attempts < maxAttempts) {
      // Check if login successful
      loggedIn = await is_logged_in(page);
      
      if (loggedIn) {
        console.log('Login successful!');
        break;
      }
      
      // Wait 5 seconds before checking again
      await new Promise(resolve => setTimeout(resolve, 5000));
      attempts++;
      
      if (attempts % 6 === 0) { // Print message every 30 seconds
        console.log('Waiting for login to complete...');
      }
    }
    
    if (!loggedIn) {
      await browser.close();
      globalBrowser = null;
      globalContext = null;
      throw new Error('Login timeout - please try again');
    }
  } else {
    console.log('Already logged in to Twitter/X');
  }
  
  // Save session to file with timestamp
  console.log('Saving session...');
  const sessionData = await context.storageState();
  fs.writeFileSync(SESSION_FILE_PATH, JSON.stringify(sessionData, null, 2));
  
  // Don't close the page - keep it for reuse
  
  return { browser, context };
};

/**
 * Get browser context with Twitter/X session
 * @returns Browser context with active session
 */
export const get_browser_with_session = async (): Promise<{ browser: Browser, context: BrowserContext }> => {
  // If we already have an active browser session, return it
  if (globalBrowser && globalContext) {
    console.log('Reusing existing browser session');
    return { browser: globalBrowser, context: globalContext };
  }
  
  const hasSession = await check_login();
  
  // Launch browser with enhanced media options
  const browserInstance = await chromium.launch({
    channel: 'chrome', // 使用已安装的Chrome而非Playwright自带Chromium
    headless: false,
    args: [
      '--autoplay-policy=no-user-gesture-required',
      '--disable-web-security',
      '--use-fake-ui-for-media-stream',
      '--enable-usermedia-screen-capturing',
      '--allow-http-screen-capture',
      '--use-fake-device-for-media-stream',
      '--enable-features=NetworkService,NetworkServiceInProcess',
      '--allow-running-insecure-content',
      '--disable-features=IsolateOrigins,site-per-process',
      '--enable-usermedia-screen-capturing',
      '--disable-gpu-sandbox',
      '--enable-gpu-rasterization',
      '--ignore-certificate-errors',
      '--enable-features=VaapiVideoDecoder',
      '--enable-features=Vulkan',
      '--no-sandbox',
      '--no-first-run',
      '--no-default-browser-check',
      '--no-zygote',
      '--use-gl=desktop',
      '--use-vulkan=native',
      '--enable-logging',
      '--disable-backgrounding-occluded-windows',
      '--enable-media-stream',
      '--enable-webgl',
      // Additional parameters for improved stability
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-pings',
      '--dns-prefetch-disable',
      // Extended cookie lifetime
      '--persistent-cookie-lifetime=30'
    ],
    chromiumSandbox: false,
    ignoreDefaultArgs: ['--mute-audio']
  });
  if (!browserInstance) {
    throw new Error('Failed to launch browser');
  }
  
  // Store globally
  globalBrowser = browserInstance;
  
  if (hasSession) {
    try {
      // Load existing session
      const sessionData = JSON.parse(fs.readFileSync(SESSION_FILE_PATH, 'utf8'));
      const context = await browserInstance.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
        viewport: { width: 1280, height: 800 },
        storageState: sessionData,
        permissions: ['microphone', 'camera', 'geolocation'],
        ignoreHTTPSErrors: true,
        bypassCSP: true,
        acceptDownloads: true,
        javaScriptEnabled: true,
        hasTouch: false,
        isMobile: false
      });
      
      // Store globally
      globalContext = context;
      
      // Verify login is still valid
      const page = await context.newPage();
      
      // Use safer navigation method
      await safeNavigate(page, 'https://x.com', 'Twitter homepage');
      
      const isStillLoggedIn = await is_logged_in(page);
      
      // Keep the page open for reuse, don't close it
      
      if (!isStillLoggedIn) {
        console.log('Session expired, logging in again...');
        // Delete invalid session
        if (fs.existsSync(SESSION_FILE_PATH)) {
          fs.unlinkSync(SESSION_FILE_PATH);
        }
        
        // Close existing context but keep browser open
        await context.close();
        globalContext = null;
        
        return login();
      }
      
      console.log('Using existing Twitter/X session');
      
      // 最后添加以下代码，在函数最后的return语句之前
      try {
        // 设置一个周期性任务来刷新会话，每30分钟刷新一次
        if (globalContext) {
          console.log('Setting up session refresh interval (every 30 minutes)');
          const refreshInterval = setInterval(async () => {
            // 检查全局上下文是否仍然有效
            if (globalContext) {
              console.log('Performing periodic session refresh...');
              await refreshSession(globalContext);
            } else {
              // 如果上下文已失效，清除定时器
              clearInterval(refreshInterval);
            }
          }, 30 * 60 * 1000); // 30分钟
          
          // 立即进行一次刷新，确保会话状态良好
          await refreshSession(globalContext);
        }
      } catch (error) {
        console.error('Error setting up session refresh:', error);
        // 即使设置会话刷新失败，仍然返回浏览器和上下文
      }
      
      return { browser: browserInstance, context };
    } catch (error) {
      console.error('Error loading session, recreating:', error);
      // Delete invalid session file
      if (fs.existsSync(SESSION_FILE_PATH)) {
        fs.unlinkSync(SESSION_FILE_PATH);
      }
      
      // Close the browser completely and start fresh
      await browserInstance.close();
      globalBrowser = null;
      globalContext = null;
      
      return login();
    }
  } else {
    // No session found, need to login
    // But don't close browser, just reuse it
    await browserInstance.close();
    globalBrowser = null;
    return login();
  }
};

// 下载文件的通用方法
const downloadFile = (url: string, outputPath: string): Promise<void> => {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(outputPath);
    https.get(url, response => {
      if (response.statusCode !== 200) {
        reject(new Error(`Failed to download ${url}, status: ${response.statusCode}`));
        return;
      }
      response.pipe(file);
      file.on('finish', () => {
        file.close();
        resolve();
      });
      file.on('error', err => {
        fs.unlink(outputPath, () => {});
        reject(err);
      });
    }).on('error', err => {
      fs.unlink(outputPath, () => {});
      reject(err);
    });
  });
};

async function downloadTwitterVideo(tweetUrl: string, outputDir: string) {
  console.log(`Downloading video from tweet: ${tweetUrl}`);
  
  // 确保输出目录存在
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  
  // 提取推文ID
  const match = tweetUrl.match(/status\/(\d+)/);
  if (!match) {
    console.error('Invalid tweet URL format');
    return;
  }
  const tweetId = match[1];
  const outputPath = path.join(outputDir, `${tweetId}.mp4`);
  
  // 启动浏览器
  const browser = await chromium.launch({
    headless: false,
    args: ['--disable-web-security']
  });
  
  const context = await browser.newContext();
  const page = await context.newPage();
  
  // 收集视频段
  const videoSegments: string[] = [];
  const audioSegments: string[] = [];
  
  // 创建临时目录
  const tempDir = path.join(outputDir, `${tweetId}-temp`);
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }
  
  // 监听所有网络请求，特别关注.m4s文件
  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = request.url();
    
    if (url.includes('.m4s')) {
      // 记录所有.m4s文件请求
      if (url.includes('/vid/')) {
        console.log(`Video segment: ${url}`);
        videoSegments.push(url);
      } else if (url.includes('/aud/')) {
        console.log(`Audio segment: ${url}`);
        audioSegments.push(url);
      }
    }
    
    route.continue();
  });
  
  try {
    // 访问推文
    await page.goto(tweetUrl, { waitUntil: 'domcontentloaded' });
    console.log('Tweet page loaded');
    
    // 等待视频元素
    const videoPlayer = await page.waitForSelector('div[data-testid="videoPlayer"]', { timeout: 30000 });
    if (!videoPlayer) {
      console.log('No video player found');
      await browser.close();
      return;
    }
    
    console.log('Video player found, clicking to trigger playback');
    await videoPlayer.click();
    
    // 等待足够长时间以捕获所有段
    console.log('Waiting to capture all video segments...');
    await page.waitForTimeout(15000);
    
    console.log(`Captured ${videoSegments.length} video segments and ${audioSegments.length} audio segments`);
    
    // 如果找到段，开始下载
    if (videoSegments.length > 0) {
      // 保存所有段URL以便调试
      fs.writeFileSync(
        path.join(outputDir, `${tweetId}-segments.json`),
        JSON.stringify({ video: videoSegments, audio: audioSegments }, null, 2)
      );
      
      // 分组段并识别最高质量的段
      const videoGroups = groupSegmentsByQuality(videoSegments);
      const audioGroups = groupSegmentsByQuality(audioSegments);
      
      // 显示可用分辨率
      console.log('Available video qualities:');
      for (const [quality, urls] of Object.entries(videoGroups)) {
        console.log(`- ${quality}: ${urls.length} segments`);
      }
      
      // 选择最高质量
      const bestVideoQuality = Object.keys(videoGroups).sort((a, b) => {
        const resA = a.split('x').map(Number);
        const resB = b.split('x').map(Number);
        const areaA = resA[0] * resA[1];
        const areaB = resB[0] * resB[1];
        return areaB - areaA; // 降序排列
      })[0];
      
      console.log(`Selected best video quality: ${bestVideoQuality}`);
      
      // 下载最高质量的段
      if (bestVideoQuality && videoGroups[bestVideoQuality]) {
        const bestVideoSegments = videoGroups[bestVideoQuality];
        
        for (let i = 0; i < bestVideoSegments.length; i++) {
          const url = bestVideoSegments[i];
          const segmentPath = path.join(tempDir, `video_${i.toString().padStart(5, '0')}.m4s`);
          
          console.log(`Downloading video segment ${i+1}/${bestVideoSegments.length}`);
          await downloadFile(url, segmentPath);
        }
        
        // 下载音频段
        const bestAudioQuality = Object.keys(audioGroups)[0]; // 通常只有一种音频质量
        if (bestAudioQuality && audioGroups[bestAudioQuality]) {
          const bestAudioSegments = audioGroups[bestAudioQuality];
          
          for (let i = 0; i < bestAudioSegments.length; i++) {
            const url = bestAudioSegments[i];
            const segmentPath = path.join(tempDir, `audio_${i.toString().padStart(5, '0')}.m4s`);
            
            console.log(`Downloading audio segment ${i+1}/${bestAudioSegments.length}`);
            await downloadFile(url, segmentPath);
          }
        }
        
        // 创建段列表文件
        const videoFiles = fs.readdirSync(tempDir).filter(f => f.startsWith('video_'));
        const audioFiles = fs.readdirSync(tempDir).filter(f => f.startsWith('audio_'));
        
        const videoListPath = path.join(tempDir, 'video_list.txt');
        const audioListPath = path.join(tempDir, 'audio_list.txt');
        
        fs.writeFileSync(videoListPath, videoFiles.sort().map(f => `file '${path.join(tempDir, f)}'`).join('\n'));
        if (audioFiles.length > 0) {
          fs.writeFileSync(audioListPath, audioFiles.sort().map(f => `file '${path.join(tempDir, f)}'`).join('\n'));
        }
        
        // 使用ffmpeg合并段
        try {
          console.log('Merging segments with ffmpeg...');
          
          let ffmpegCmd;
          if (audioFiles.length > 0) {
            ffmpegCmd = `ffmpeg -f concat -safe 0 -i "${videoListPath}" -f concat -safe 0 -i "${audioListPath}" -c copy "${outputPath}" -y`;
          } else {
            ffmpegCmd = `ffmpeg -f concat -safe 0 -i "${videoListPath}" -c copy "${outputPath}" -y`;
          }
          
          execSync(ffmpegCmd, { stdio: 'inherit' });
          
          console.log(`Video successfully downloaded to: ${outputPath}`);
        } catch (ffmpegError) {
          console.error('Error merging segments:', ffmpegError);
        }
      }
    }
  } catch (error) {
    console.error('Error:', error);
  } finally {
    await browser.close();
    
    // 清理临时文件
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (e) {
      console.log(`Failed to clean up temp directory: ${e}`);
    }
  }
}

// 按质量对分段进行分组
function groupSegmentsByQuality(segments: string[]): Record<string, string[]> {
  const groups: Record<string, string[]> = {};
  
  for (const url of segments) {
    // 从URL中提取质量信息
    let quality = 'unknown';
    
    // 对于视频段，我们寻找分辨率, 例如 1280x720
    const resMatch = url.match(/(\d+)x(\d+)/);
    if (resMatch) {
      quality = resMatch[0];
    } else {
      // 对于音频段，我们寻找比特率, 例如 128000
      const bitrateMatch = url.match(/(\d+)000/);
      if (bitrateMatch) {
        quality = `${bitrateMatch[1]}kbps`;
      }
    }
    
    if (!groups[quality]) {
      groups[quality] = [];
    }
    groups[quality].push(url);
  }
  
  return groups;
}

// 添加一个会话刷新函数
/**
 * Refresh Twitter session to keep it alive
 * @param context Browser context with active session
 */
export const refreshSession = async (context: BrowserContext): Promise<void> => {
  try {
    // Create a page just for refreshing the session
    const page = await context.newPage();
    
    // Visit Twitter homepage
    await safeNavigate(page, 'https://x.com', 'Twitter homepage (session refresh)');
    
    // Check if still logged in
    const loggedIn = await is_logged_in(page);
    
    if (loggedIn) {
      // Save the updated session state
      console.log('Session refreshed, saving updated cookies...');
      const sessionData = await context.storageState();
      
      // Create a backup of the current session file
      if (fs.existsSync(SESSION_FILE_PATH)) {
        const backupPath = `${SESSION_FILE_PATH}.backup`;
        fs.copyFileSync(SESSION_FILE_PATH, backupPath);
      }
      
      // Save the updated session
      fs.writeFileSync(SESSION_FILE_PATH, JSON.stringify(sessionData, null, 2));
    } else {
      console.warn('Session refresh failed, not logged in anymore.');
    }
    
    // Close the refresh page
    await page.close();
  } catch (error) {
    console.error('Error refreshing session:', error);
  }
};
