import { Page } from 'playwright';

/**
 * Navigate to a URL with improved error handling
 * @param page - Playwright page
 * @param url - URL to navigate to
 * @param description - Description for logging
 */
export const safeNavigate = async (page: Page, url: string, description: string): Promise<boolean> => {
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