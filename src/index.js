process.env.SENTRY_DSN =
  process.env.SENTRY_DSN ||
  'https://75354e82532a4cebaac04b1360e9b990@sentry.cozycloud.cc/96'

const {
  BaseKonnector,
  requestFactory,
  signin,
  scrape,
  saveFiles,
  saveBills,
  cozyClient,
  log
} = require('cozy-konnector-libs')
const pdfjs = require('pdfjs-dist')
const request = requestFactory({
  // debug: true,
  cheerio: true,
  json: false,
  jar: true
})
const moment = require('moment')

const baseUrl = 'https://sante-espaceparticuliers.humanis.com/'

module.exports = new BaseKonnector(start)

async function start(fields) {
  log('info', 'Authenticating ...')
  await authenticate(fields.login, fields.password)
  log('info', 'Successfully logged in')

  // first get the pdf reimbursemnts files and read references into it with pdfjs
  log('info', 'Fetching pdf bills')
  let files = await fetchFiles()
  files = await saveFiles(files, fields, {
    contentType: 'application/pdf',
    sourceAccount: this._account._id,
    sourceAccountIdentifier: fields.login
  })
  files = await fetchRefsInPdf(files)

  log('info', 'Fetching the list of documents')
  const $ = await request(
    `${baseUrl}e-releves-et-remboursements/vos-derniers-remboursements-sante`
  )
  log('info', 'Parsing list of documents')
  let reimbursements = await parseReimbursements($)
  const bills = []
  for (let reimbursement of reimbursements) {
    Array.prototype.push.apply(bills, await fetchDetails(reimbursement))
  }

  log('info', 'Linking documents with files')
  linkBillsWithFiles(bills, files)

  log('info', 'Saving data to Cozy')
  await saveBills(bills, fields, {
    identifiers: ['humanis'],
    keys: ['vendorRef'],
    sourceAccount: this._account._id,
    sourceAccountIdentifier: fields.login
  })
}

async function linkBillsWithFiles(bills, files) {
  bills.forEach(bill => {
    const linkedFile = files.find(file => {
      return file.refs.includes(bill.vendorRef)
    })
    if (linkedFile) {
      bill.fileurl = linkedFile.fileurl
      bill.filename = linkedFile.filename
    } else {
      log('warn', `Could not find linked file for ${bill.vendorRef}`)
    }
  })
}

async function fetchRefsInPdf(files) {
  for (let file of files) {
    const text = await getPdfText(file.fileDocument._id)
    const matches = text.match(/([A-Z] \d{2} \d{3} \d{5})+/g)
    file.refs = matches ? matches.map(ref => ref.replace(/ /g, '')) : []
  }
  return files
}

async function getPdfText(fileId) {
  const response = await cozyClient.files.downloadById(fileId)
  const buffer = await response.buffer()
  const document = await pdfjs.getDocument(buffer)
  const page = await document.getPage(1)
  const items = (await page.getTextContent()).items

  return items ? items.map(doc => doc.str).join(' ') : []
}

async function fetchFiles() {
  const $ = await request(
    baseUrl + 'e-releves-et-remboursements/vos-e-releves-sante'
  )
  moment.locale('fr')
  return scrape(
    $,
    {
      date: {
        sel: '.date .text',
        parse: date => moment(date, 'MMMM YYYY')
      },
      fileurl: {
        sel: '.download-pdf-document',
        attr: 'href',
        parse: href => baseUrl + href
      },
      amount: {
        sel: '.amount .text',
        parse: amount => parseFloat(amount.replace(' €', ''))
      }
    },
    '.estatement-row'
  )
    .filter(doc => doc.amount !== '0.00 €')
    .map(doc => {
      doc.filename = `${doc.date.format('YYYY_MM').replace('.', ',')}_${
        doc.amount
      }€_Humanis.pdf`
      delete doc.date
      delete doc.amount
      return doc
    })
}

async function fetchDetails(doc) {
  /* eslint-disable require-atomic-updates */
  const $ = await request(baseUrl + doc._detailsUrl)
  delete doc._detailsUrl
  doc.beneficiary = $('.group-name')
    .text()
    .trim()
    .split(' ')
    .slice(1)
    .join(' ')

  const details = scrape(
    $,
    {
      subtype: '.categories .text',
      originalDate: {
        sel: '.date-des-soins .text',
        parse: date => moment(date, 'DD/MM/YYYY').toDate()
      },
      originalAmount: {
        sel: '.depenses .text',
        parse: amount => parseFloat(amount.trim().replace(' €', ''))
      },
      socialSecurityRefund: {
        sel: '.remboursement-secu .text',
        parse: amount => parseFloat(amount.trim().replace(' €', ''))
      },
      amount: {
        sel: '.remboursement-notre .text',
        parse: amount => parseFloat(amount.trim().replace(' €', ''))
      }
    },
    '.transfer-details-row'
  )

  return details.map(detail => ({
    ...doc,
    ...detail,
    isRefund: true,
    currency: 'EUR',
    metadata: {
      importDate: new Date(),
      version: 1
    }
  }))
}

function authenticate(name, pass) {
  return signin({
    url: baseUrl,
    formSelector: 'form',
    formData: { name, pass },
    validate: (statusCode, $) => {
      const errors = $('.messages--error')
      if (errors.length) {
        log('error', errors.text())
        return false
      } else return true
    }
  })
}

// The goal of this function is to parse a html page wrapped by a cheerio instance
// and return an array of js objects which will be saved to the cozy by saveBills (https://github.com/konnectors/libs/blob/master/packages/cozy-konnector-libs/docs/api.md#savebills)
function parseReimbursements($) {
  return Array.from($('.transfer-row'))
    .map(row => {
      const $row = $(row)
      return {
        type: 'health_costs',
        date: moment(
          $row
            .find('.date')
            .text()
            .trim(),
          'DD/MM/YY'
        ).toDate(),
        groupAmount: parseFloat(
          $row
            .find('.montant span.text')
            .text()
            .trim()
            .replace(' €', '')
        ),
        vendorRef: $row
          .find('.dossier span.text')
          .text()
          .trim(),
        _detailsUrl: $row.find('.details a').attr('href'),
        vendor: 'Humanis'
      }
    })
    .filter(doc => doc.groupAmount !== 0)
}
