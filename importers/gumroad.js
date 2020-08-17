const cloudscraper = require('cloudscraper');
const { posts, bans } = require('../db');
const scrapeIt = require('scrape-it');
const path = require('path');
const checkForFlags = require('../flagcheck');
const downloadFile = require('../download');
const Promise = require('bluebird');
const { URL } = require('url');
const indexer = require('../indexer');

const apiOptions = key => {
  return {
    json: true,
    headers: {
      cookie: `_gumroad_session=${key}`
    }
  };
};
const scrapeOptions = key => {
  return {
    headers: {
      cookie: `_gumroad_session=${key}`
    }
  };
};

async function scraper (key, from = 1) {
  const gumroad = await cloudscraper.get(`https://gumroad.com/discover_search?from=${from}&user_purchases_only=true`, apiOptions(key));
  if (gumroad.total > 500000) return; // not logged in
  const data = await scrapeIt.scrapeHTML(gumroad.products_html, {
    products: {
      listItem: '.product-card',
      data: {
        id: {
          attr: 'data-permalink'
        },
        purchaseId: {
          selector: '.js-product',
          attr: 'data-purchase-id'
        },
        title: '.description-container h1 strong',
        userHref: {
          selector: '.description-container .js-creator-profile-link',
          attr: 'href'
        },
        previews: {
          selector: '.preview-container',
          attr: 'data-asset-previews',
          convert: x => JSON.parse(x)
        }
      }
    }
  });
  await Promise.map(data.products, async (product) => {
    const userId = new URL(product.userHref).pathname.replace('/', '');
    const banExists = await bans.findOne({ id: userId, service: 'gumroad' });
    if (banExists) return;
    await checkForFlags({
      service: 'gumroad',
      entity: 'user',
      entityId: userId,
      id: product.id
    });
    const postExists = await posts.findOne({ id: product.id, service: 'gumroad' });
    if (postExists) return;

    const model = {
      version: 2,
      service: 'gumroad',
      title: product.title,
      content: '',
      id: product.id,
      user: userId,
      post_type: 'image',
      added_at: new Date().getTime(),
      published_at: '',
      post_file: {},
      attachments: []
    };
    const productPage = await cloudscraper.get(`https://gumroad.com/library/purchases/${product.purchaseId}`, scrapeOptions(key));
    const productData = await scrapeIt.scrapeHTML(productPage, {
      contentUrl: {
        selector: '.button.button-primary.button-block',
        attr: 'href'
      }
    });
    const downloadPage = await cloudscraper.get(productData.contentUrl, scrapeOptions(key));
    const downloadData = await scrapeIt.scrapeHTML(downloadPage, {
      thumbnail1: {
        selector: '.image-preview-container img',
        attr: 'src'
      },
      thumbnail2: {
        selector: '.image-preview-container img',
        attr: 'data-cfsrc'
      },
      thumbnail3: {
        selector: '.image-preview-container noscript img',
        attr: 'src'
      },
      data: {
        selector: 'div[data-react-class="DownloadPage/FileList"]',
        attr: 'data-react-props',
        convert: x => {
          try {
            return JSON.parse(x);
          } catch (err) {
            return {
              files: [],
              download_info: {}
            };
          }
        }
      }
    });

    const thumbnail = downloadData.thumbnail1 || downloadData.thumbnail2 || downloadData.thumbnail3;
    if (thumbnail) {
      const urlBits = new URL(thumbnail).pathname.split('/');
      const filename = urlBits[urlBits.length - 1].replace(/%20/g, '_');
      await downloadFile({
        ddir: path.join(process.env.DB_ROOT, `/files/gumroad/${userId}/${product.id}`),
        name: filename
      }, {
        url: thumbnail
      });
      model.post_file.name = filename;
      model.post_file.path = `/files/gumroad/${userId}/${product.id}/${filename}`;
    }

    await Promise.map(downloadData.data.files, async (file) => {
      await downloadFile({
        ddir: path.join(process.env.DB_ROOT, `/attachments/gumroad/${userId}/${product.id}`),
        name: `${file.file_name}.${file.extension.toLowerCase()}`
      }, Object.assign({
        url: 'https://gumroad.com' + downloadData.data.download_info[file.id].download_url
      }, scrapeOptions(key)))
        .then(res => {
          model.attachments.push({
            name: res.filename,
            path: `/attachments/gumroad/${userId}/${product.id}/${res.filename}`
          });
        });
    });

    posts.insertOne(model);
  });

  if (data.products.length) {
    scraper(key, from + gumroad.result_count);
  } else {
    indexer();
  }
}

module.exports = data => scraper(data);
