import { find_links } from './main';

async function main() {
  try {
    // Parse command line arguments
    const args = process.argv.slice(2);
    
    // Default Twitter handle if not provided
    const twitterHandle = args[0] || 'elonmusk';
    const url = `https://x.com/${twitterHandle}`;
    
    // Parse configuration options with defaults
    const max_id = args[1] ? parseInt(args[1]) : 5;     // Number of posts to process
    const limit = args[2] ? parseInt(args[2]) : 10;      // Number of links to return
    const download_content = args[3] === 'false' ? false : true;  // Download content by default
    const output_dir = args[4] || './output';            // Output directory
    
    console.log(`Starting scraper for user: ${twitterHandle}`);
    console.log(`Configuration:`);
    console.log(`- Process up to ${max_id === 0 ? 'unlimited' : max_id} posts`);
    console.log(`- Return up to ${limit === 0 ? 'unlimited' : limit} links`);
    console.log(`- ${download_content ? 'Download' : 'Skip downloading'} content`);
    console.log(`- Output directory: ${output_dir}`);
    
    console.log('\nNote: If this is the first time running the script, a browser window will open');
    console.log('for you to log in to Twitter/X. The session will be saved for future runs.');
    
    // Execute the main function
    const links = await find_links(url, max_id, limit, download_content, output_dir);
    
    console.log('\n=== RESULTS ===');
    console.log(`Total unique posts found: ${links.length}`);
    console.log('List of post URLs:');
    links.forEach((link, index) => {
      console.log(`${index + 1}. ${link}`);
    });
    
    if (download_content) {
      console.log(`\nContent has been downloaded to: ${output_dir}/${twitterHandle}/`);
      console.log('Downloaded content includes:');
      console.log('- Text files (.txt) containing tweet text and metadata');
      console.log('- Images (.jpg, .png, etc.) from tweets');
      console.log('- Videos (.mp4) downloaded using ffmpeg (requires ffmpeg installation)');
      console.log('- Video URL files (in case ffmpeg download fails)');
    }
    
    // Give the user time to see the results before exiting
    console.log('\nPress Ctrl+C to exit the program.');
  } catch (error) {
    console.error('Error running test:', error);
    process.exit(1);
  }
}

// Display usage information if --help is specified
if (process.argv.includes('--help')) {
  console.log('\nTwitter/X Post Scraper');
  console.log('---------------------');
  console.log('Usage: npx ts-node src/test_twitter.ts [handle] [max_posts] [max_links] [download_content] [output_dir]');
  console.log('\nParameters:');
  console.log('  handle          - Twitter/X username (default: elonmusk)');
  console.log('  max_posts       - Maximum posts to scroll through, 0 for unlimited (default: 50)');
  console.log('  max_links       - Maximum links to return, 0 for unlimited (default: 20)');
  console.log('  download_content - Whether to download content, true or false (default: true)');
  console.log('  output_dir      - Directory to save content (default: ./output)');
  console.log('\nExamples:');
  console.log('  npx ts-node src/test_twitter.ts elonmusk');
  console.log('  npx ts-node src/test_twitter.ts jack 100 50');
  console.log('  npx ts-node src/test_twitter.ts TwitterDev 0 0 true ./twitter_data');
  process.exit(0);
}

main(); 