require('dotenv').config();

const { Client, collectPaginatedAPI } = require('@notionhq/client');
const notion = new Client({ auth: process.env.NOTION_SECRET });

const axios = require('axios').default;
const sharp = require('sharp');
const { Readable } = require('stream');

const cron = require('node-cron');

const { BlobServiceClient, ContainerClient } = require("@azure/storage-blob");
const blobServiceClient = BlobServiceClient.fromConnectionString(process.env.AZURE_STORAGE_CONNECTION_STRING);
const containerClient = blobServiceClient.getContainerClient('$web');

/**
 * @param binary Buffer
 * returns readableInstanceStream Readable
 */
 function bufferToStream(binary) {

  const readableInstanceStream = new Readable({
    read() {
      this.push(binary);
      this.push(null);
    }
  });

  return readableInstanceStream;
}

async function getContributions() {
  console.log('Getting contributions...')
  const d = new Date();
  const dateString = d.getFullYear().toString() + '-' + (d.getMonth()+1).toString().padStart(2, '0');
  const contributionsResponse = await collectPaginatedAPI(notion.databases.query, {database_id: process.env.NOTION_DATABASE_CONTRIBUTIONS});
  return contributionsResponse.filter(x => (x.properties.Lifetime.checkbox === true || x.properties[dateString].checkbox === true) && x.properties['💋 Companion'].relation.length > 0).map(x => x.properties['💋 Companion'].relation[0].id);
}

async function getBannedKeywords()
{
  console.log('Getting banned keywords...')
  const bannedKeywordsResponse = await collectPaginatedAPI(notion.databases.query, {database_id: process.env.NOTION_DATABASE_KEYWORDS});
  return bannedKeywordsResponse.map(x => x.properties.Name.title[0].plain_text);
}

async function getCompanions(contributions, bannedKeywords) {
  console.log('Getting companions...')
  const companionsResponse = await collectPaginatedAPI(notion.databases.query, { database_id: process.env.NOTION_DATABASE_COMPANIONS });
  const companions = companionsResponse.filter(x => contributions.includes(x.id) && x.properties.Picture.files.length > 0 && (x.properties.Retirement.date == null || x.properties.Retirement.date > Date.now)).map(x => ({id: x.id, name: x.properties.Name.title[0].plain_text, url: x.properties.Website.url, services: x.properties.Services.multi_select.map(y => y.name), race: x.properties.Race.multi_select.map(y => y.name), gender: x.properties.Gender.multi_select.map(y => y.name), catersto: x.properties['Caters to'].multi_select.map(y => y.name), age: x.properties.Age.multi_select.map(y => y.name), body_type: x.properties["Body type"].multi_select.map(y => y.name), height: x.properties.Height.multi_select.map(y => y.name), tattoos: x.properties['Tattoos & mods'].multi_select.map(y => y.name), body_hair: x.properties['Body hair'].multi_select.map(y => y.name), tagline: x.properties.Tagline.rich_text.length > 0 ? x.properties.Tagline.rich_text[0].plain_text : null, keywords: x.properties.Keywords.rich_text.length > 0 ? x.properties.Keywords.rich_text[0].plain_text.toLowerCase() : "", location: x.properties.Location.multi_select.map(y => y.name)}))

  if (!process.argv.includes('--skip-pictures')) {
    await refreshCompanionPictures(companionsResponse.filter(x => x.properties.Picture.files.length > 0));
  }

  // Remove BannedKeywords
  bannedKeywords.forEach(function(bannedKeyword, i) {
    companions.forEach(function(companion, j) {
        if (companion.keywords != null && companion.keywords.includes(bannedKeyword))
        {
            console.log(`${bannedKeyword} + ${companion.name}`);
            companion.keywords = companion.keywords.replace(bannedKeyword, '');
        }
    });
  });

  // Add extra keywords
  companions.forEach(function(companion) {
    if (companion.catersto.includes("Disabilities")) {
      companion.keywords = companion.keywords + ", disability, disabilities";
    }
  });

  return companions;
}

async function refreshCompanionPictures(companionsResponse) {
  // For each companion
  console.log('Refreshing pictures...')
  for (const companion of companionsResponse)
  {
      // Make sure there's a picture in there
      if (companion.properties.Picture.files.length == 0) continue;

      const url = companion.properties.Picture.files[0].file.url;
      const blockBlobClient = containerClient.getBlockBlobClient(`img/companions/${companion.id}.jpg`);
      
      // Get picture from Notion
      const response = await axios.get(url, {responseType: "arraybuffer"});

      try {
        // Resize picture
        const resizedImage = await sharp(response.data)
        .resize({
          width: 500,
          height: 750,
          fit: sharp.fit.cover,
          position: sharp.strategy.attention
        })
        .jpeg({quality: 80})
        .toBuffer();

        // Upload to Azure Storage
        const uploadResponse = await blockBlobClient.uploadStream(bufferToStream(resizedImage));
      } catch (ex) {
        console.log(`[WARNING] Something went wrong with ${companion.properties.Name.title[0].plain_text}'s picture: ${ex.message}`);
      }
  };
  console.log(`Done. Refreshed ${companionsResponse.length} pictures`)
}

async function main() {
  var contributions = await getContributions();
  var bannedKeywords = await getBannedKeywords();

  var companions = await getCompanions(contributions, bannedKeywords);
  var companionsString = JSON.stringify(companions);

  // Update main json file
  const blockBlobClient = containerClient.getBlockBlobClient('companions.json');
  await blockBlobClient.upload(companionsString, companionsString.length);

  console.log(`Updated ${companions.length} companions.`);
}

console.log("Starting app...");

if (process.argv.includes('--now'))
{
  console.log(`[${(new Date()).toString()}] Running task...`);
  main()
  .then(() => console.log("Done"))
  .catch((ex) => console.log(ex.message));
}
else {
  console.log('Waiting for cron job')
  cron.schedule('0 */4 * * *', function() {
    console.log(`[${(new Date()).toString()}] Running task...`);
    main()
    .then(() => console.log("Done"))
    .catch((ex) => console.log(ex.message));
  });
}