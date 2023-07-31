const dotenv = require('dotenv');
dotenv.config();

const { Client } = require('@notionhq/client');
const { requireEnv } = require('./src/utils');

let notionClient = new Client({
  auth: requireEnv('NOTION_TOKEN'),
});

async function run() {
  let {
    results: pages,
    has_more,
    next_cursor,
  } = await notionClient.databases.query({
    database_id: '335acbcea9a141ec8f5a592457f23e49',
  });

  const { results } = await notionClient.blocks.children.list({
    block_id: pages[0].id,
  });

  console.log(JSON.stringify(results, null, 2));
}

run();
