/*
  Collection of functions used in order to get curse modpacks
  Since they lack a proper API (documentation), modpacks have to be obtained using force (aka following redirects and stuff)
*/
const url = require('url')
const fs = require('fs')
const path = require('path')

function HTTPRequest(link, callback) {
  let parsed = url.parse(link)
  let opts = {
    host: parsed.hostname,
    port: parsed.port,
    path: parsed.path,
    'headers':{
      'User-Agent': 'curl/7.53.1',
      'Accept': '*/*',
      'Accept-Language': 'en-GB,enq=0.5'
    }
  }

  const httpModule = parsed.protocol === 'https:' ? require('https') : require('http')

  httpModule.get(opts, function (res) {
    let data = ''
    res.on('data', function (chunk) {
      data += chunk
    })

    res.on('end', function () {
      callback(null, data, res)
    })

  }).on('error', function (e) {
    callback(e.message, null, null)
  })
}

function determineProjectByID (id, cb) {
  HTTPRequest('https://mods.curse.com/project/' + id, (error, data, response) => {
    if (!response.headers.location || error !== null) return cb('noloc', null)

    let projectName = response.headers.location.split('/')
    projectName = projectName[projectName.length - 1]
    projectName = decodeURIComponent(projectName.replace(/^\d+-/g, ''))

    if (projectName) return cb(null, projectName)

    cb('failed', null)
  })
}

function hitFile (link, target, fname, cb, progress) {
  let parsed = url.parse(link)
  let opts = {
    host: parsed.hostname,
    port: parsed.port,
    path: parsed.path,
    'headers':{
      'User-Agent': 'curl/7.53.1',
      'Accept': '*/*',
      'Accept-Language': 'en-GB,enq=0.5'
    }
  }

  let originalFname = fname
  fname = parsed.path.split('/')
  fname = fname[fname.length - 1]
  fname = decodeURIComponent(fname)

  const httpModule = parsed.protocol === 'https:' ? require('https') : require('http')

  let mb
  let mbtotal

  httpModule.get(opts, function(res) {
    let len = res.headers['content-length']

    if (res.headers.location) {
      hitFile(res.headers.location, target, originalFname, cb, progress)
      return
    }

    if (res.statusCode === 404) {
      return cb('Failed download of ' + originalFname, null)
    }

    let exists = false

    try {
      exists = fs.existsSync(path.join(target, fname))
    } catch (e) {
      exists = false
    }

    if (exists) return cb(null, fname)

    let fstream = fs.createWriteStream(path.join(target, fname))
    res.on('data', function (data) {
      fstream.write(data)
      let percent = ((fstream.bytesWritten / len) * 100).toFixed(2)
      mb = (fstream.bytesWritten / 1024 / 1024).toFixed(1)
      mbtotal = (len / 1024 / 1024).toFixed(1)
      if (progress) {
        progress(fname, percent, mb, mbtotal)
      }
    }).on('end', function () {
      cb(null, fname)
    }).on('error', function (err) {
      cb(err, null)
    })
  })
}

function curseFile (projectId, fileId, vpath, cb, progress) {
  determineProjectByID(projectId, (err, project) => {
    if (err) return cb(err, null)
    hitFile('https://minecraft.curseforge.com/projects/' + project + '/files/' + fileId +
      '/download', vpath, fileId + '.jar', cb, progress)
  })
}

function patchDirs(dir, patch) {
  fs.readdirSync(patch).forEach(function(file) {
    if (fs.existsSync(dir + '/' + file)) {
      if (fs.statSync(dir + '/' + file).isDirectory()) {
        return patchDirs(dir + '/' + file, patch + '/' + file)
      }
      fs.unlinkSync(dir + '/' + file)
    }
    fs.renameSync(patch + '/' + file, dir + '/' + file)
  })
}

module.exports = {
  determineProjectByID: determineProjectByID,
  hitFile: hitFile,
  curseFile: curseFile,
  patchDirs: patchDirs
}
