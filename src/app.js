// region definitions
const dotenv = require('dotenv');
dotenv.config();

const cron = require('node-cron');
const { Client } = require('@notionhq/client');
const { MemClient } = require('@mem-labs/mem-node');
const { requireEnv } = require('./utils');
const databaseId = requireEnv('NOTION_DATABASE_ID');
const propertyNames = {
  memSyncStatus: requireEnv('NOTION_SYNC_STATUS', 'memai-sync-status'),
  memSyncId: requireEnv('NOTION_SYNC_ID', 'memai-sync-id'),
  memSyncDate: requireEnv('NOTION_LAST_SYNC', 'memai-last-sync'),
};

let notionClient = new Client({
  auth: requireEnv('NOTION_TOKEN'),
});

const memClient = new MemClient({
  apiAccessToken: requireEnv('MEM_TOKEN'),
});

//endregion definitions

function mapCategory(category) {
  switch (category) {
    case 'Articles':
      return requireEnv('MAPPING_ARTICLES', 'article');
    case 'Books':
      return requireEnv('MAPPING_BOOKS', 'book');
    case 'Tweets':
      return requireEnv('MAPPING_TWEETS', 'tweet');
    case 'Podcasts':
      return requireEnv('MAPPING_PODCASTS', 'podcast');
  }
}

async function maybeWait1Second(startTime) {
  const elapsedTime = Date.now() - startTime;

  if (elapsedTime >= 1000) {
    console.log('no need to wait', elapsedTime);
    return await Promise.resolve();
  } else {
    console.log(`need to wait ${1000 - elapsedTime}ms`);
    return await new Promise((resolve) => {
      setTimeout(() => resolve(), 1000 - elapsedTime);
    });
  }
}

async function createMem(content, memId) {
  console.log(`using memId '${memId}'`);
  if (memId === '') {
    console.log('Creating new mem');
    return await memClient
      .createMem({
        content,
      })
      .then((response) => {
        console.log('Created new mem', response.id);
        return response.id;
      });
  } else {
    console.log('Updating mem');
    return await fetch(`https://api.mem.ai/v0/mems/${memId}/append`, {
      headers: {
        Authorization: `ApiAccessToken ${requireEnv('MEM_TOKEN')}`,
        'Content-Type': 'application/json',
      },
      method: 'POST',
      body: JSON.stringify({
        content,
      }),
    })
      .then(async (response) => response.json())
      .then((value) => {
        console.log('updated mem:', value);
        return value.id;
      });
  }
}

async function runExport() {
  let allItemsSize = 0;
  await exportForPage((size) => (allItemsSize += size));
  console.log(`Finished processing ${allItemsSize} items.`);
}

async function exportForPage(addSize, startCursor) {
  let { results, has_more, next_cursor } = await notionClient.databases.query({
    database_id: databaseId,
    start_cursor: startCursor,
  });
  console.log(`run export for ${results.length} elements`);
  addSize(results.length);
  for (const page of results) {
    const startTime = Date.now();

    if (await exportDatabaseItem(page)) {
      await maybeWait1Second(startTime);
    }
  }

  if (has_more) {
    await exportForPage(addSize, next_cursor);
  }
}

async function loadPageContent(item) {
  function loadPage(startCursor) {
    return notionClient.blocks.children.list({
      block_id: item.id,
      start_cursor: startCursor,
    });
  }

  let nextCursor = undefined;
  let result = [];
  while (true) {
    let page = await loadPage(nextCursor);
    nextCursor = page.next_cursor;
    result = [...result, ...page.results];

    if (!page.has_more) {
      break;
    }
  }
  return result;
}

async function exportDatabaseItem(item) {
  const result = [];
  const syncId = item.properties[propertyNames.memSyncId]['rich_text']
    .map((text) => text.plain_text)
    .join(', ');
  const url = item.properties['URL']['url'];
  const title = item.properties['Full Title']['rich_text']
    .map((text) => text.plain_text)
    .join(' ');
  const category = item.properties['Category']['select']['name'];
  const author = item.properties['Author']['rich_text']
    .map((text) => text.plain_text)
    .join(' ');

  const existingMem = syncId === '';

  function pushMetadata() {
    result.push(`# ${title}\n`);
    result.push(`${requireEnv('DEFAULT_TAGS', '#readwise-import')} `);
    result.push(`#${mapCategory(category)}\n`);
    result.push(`**Author:** @${author}\n`);
    result.push(`**URL:** ${url}\n\n`);
    result.push('---\n');
  }

  if (existingMem) {
    pushMetadata();
  } else {
    result.push('\n---\n');
  }

  function pushTextItem(textItem) {
    let textContent = textItem.content
      .replace(/#(\w+)/g, '"#$1"')
      .replace('•   ', '- ');
    if (textItem.link) result.push(`[${textContent}](${textItem.link.url})`);
    else result.push(textContent);
  }

  return await loadPageContent(item)
    .then((content) => {
      content.forEach((block) => {
        result.push('\n');

        if (block.type === 'paragraph') {
          block.paragraph.rich_text.forEach((textItem) => {
            pushTextItem(textItem.text);
          });
        } else if (block.type === 'image') {
          pushTextItem({
            content: block.image.external.url,
          });
        }
      });

      return content;
    })
    .then(async (blocks) => {
      if (blocks.length > 0) {
        let syncDate = new Date();
        result.push(`\n**Synced on** ${syncDate.toLocaleString('de')}\n\n`);

        const memId = await createMem(result.join(''), syncId);
        const properties = {};
        properties[propertyNames.memSyncId] = {
          rich_text: [
            {
              text: {
                content: memId,
              },
            },
          ],
        };
        properties[propertyNames.memSyncStatus] = {
          select: {
            name: 'SYNCED',
          },
        };
        properties[propertyNames.memSyncDate] = {
          date: {
            start: syncDate.toISOString(),
          },
        };
        await notionClient.pages.update({
          page_id: item.id,
          properties,
        });

        for (const block of blocks) {
          await new Promise(async (resolve) => {
            await notionClient.blocks.delete({ block_id: block.id });
            setTimeout(() => resolve(), 10);
          });
        }
      } else {
        console.log(`No need to update ${syncId}`);
        return false;
      }
      return true;
    });
}

async function createDailyNote() {
  let cron = requireEnv('DAILY_NOTE_CRON');
  console.log('create daily note');
  const content = `# Daily note ${new Date()
    .toLocaleDateString('de-DE')
    .split('/')
    .join('.')}
#notiz #daily

## Aufgaben für heute

##Notizen
`;
  await memClient.createMem({
    content,
  });
}

async function initialize() {
  await runExport(); // run on startup

  const cronSchedule = requireEnv('CRON_SCHEDULE', '*/15 * * * *');
  console.log('Creating cron with schedule', cronSchedule);

  cron.schedule(cronSchedule, async () => {
    await runExport();
  });

  const daily = requireEnv('DAILY_NOTE_CRON', null);

  if (daily) {
    cron.schedule(daily, async () => {
      await createDailyNote();
    });
  }
}

initialize().catch(console.error);
