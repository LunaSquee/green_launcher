const os = require('os')
const path = require('path')
const fs = require('fs')
const fse = require('fs-extra')
const urllib = require('url')
const uuid = require('uuid/v4')
const async = require('async')
const lzma = require('lzma-native')
const extractZip = require('extract-zip')
const childprocess = require('child_process')
const crypto = require('crypto')
const util = require('util')
const {ipcRenderer} = require('electron')

const directory = '.3rdmc'
const home = path.resolve(os.homedir())
const dataDir = path.join(home, directory)
const versions = path.join(dataDir, 'versions')
const packs = path.join(dataDir, 'modpacks')
const assets = path.join(dataDir, 'assets')
const libraries = path.join(dataDir, 'libraries')
const games = path.join(dataDir, 'games')
const tmpdir = path.join(dataDir, '.tmp')

const curse = require(path.join(__dirname, 'curseDance'))

const OSMemory = Math.floor(os.totalmem() / Math.pow(1024, 3))
let platform = 'linux'
let currentProgram = {
  natives: null,
  process: null,
  libraries: [],
  game: null,
  type: 'release'
}

switch (process.platform) {
  case 'win32':
    platform = 'windows'
    break
  case 'darwin':
    platform = 'osx'
    break
  default:
    platform = 'linux'
}

let configuration = {
  client: uuid(),
  accessToken: null,
  user: null,
  permgen: 1,
  launchervis: 0,
  executable: 'java',
  jvm: '-XX:+UseConcMarkSweepGC -XX:+CMSIncrementalMode -XX:-UseAdaptiveSizePolicy -Xmn128M',
  versions: [],
  modpacks: []
}

let queue = []
let versionsList = []

let Windowing = {
  current: $('#loading'),
  switch: (win) => {
    let elem = $(win)
    if (elem.hasClass('window')) {
      Windowing.current.hide()
      elem.show()
      Windowing.current = elem
    }
  }
}

let Dialog = {
  closable: true,
  pop: (title, content) => {
    $('#dialog #title').text(title)
    $('#dialog #content').html(content)
    $('#dialog').fadeIn()
  },
  close: () => {
    Dialog.setClosePossible(true)
    $('#dialog').fadeOut()
  },
  setClosePossible: (val) => {
    Dialog.closable = val
    if (val) {
      $('#dialog .close').show()
    } else {
      $('#dialog .close').hide()
    }
  }
}

$('#dialog .close').click(function() {
  Dialog.close()
})

window.dialog = Dialog

function nparamparser (str, data) {
  let final = str

  for (let i in data) {
    final = final.replace('${' + i + '}', data[i])
  }

  return final.replace(/\$\{\w+_\}/g, 'null')
}

function logMsg (type) {
  let message = util.format.apply(null, Array.prototype.slice.call(arguments, 1))
  $('#log').append('<div class="logmsg ' + type + '">' + message + '</div>')
  $('#log').scrollTop($('#log').scrollTop() + $('#log').height())
}

function launch (game, launchOpts) {
  let gameJar = path.join(versions, game.version, game.version + '.jar')
  let gameMeta = path.join(versions, game.version, game.version + '.json')

  currentProgram.game = game
  currentProgram.libraries.push(gameJar)

  let jargs = configuration.jvm
  let libPaths = currentProgram.libraries.join(':')

  jargs += ' -Xmx' + configuration.permgen * 1000 + 'M'
  jargs += ' -Djava.library.path=' + currentProgram.natives
  jargs += ' -cp ' + libPaths
  jargs += ' ' + launchOpts.class

  let properties = {
    auth_player_name: configuration.user.name,
    version_name: game.version,
    game_directory: game.game,
    assets_root: assets,
    assets_index_name: launchOpts.assetIndex,
    auth_uuid: configuration.user.id,
    auth_access_token: configuration.accessToken,
    user_type: 'legacy',
    version_type: currentProgram.type
  }

  jargs += ' ' + nparamparser(launchOpts.args, properties)

  if (configuration.launchervis !== 2) {
    ipcRenderer.send('toggle', false)
  }

  let executable = configuration.executable || 'java'

  // CREATE PROCESS
  let proc = currentProgram.process = childprocess.spawn(executable, jargs.split(' '), {cwd: game.game})
  proc.stdout.on('data', (data) => {
    logMsg('stdout', data.toString())
  })

  proc.stderr.on('data', (data) => {
    logMsg('stderr', data.toString())
  })

  proc.on('close', (code) => {
    fse.removeSync(currentProgram.natives)

    currentProgram.process = null
    currentProgram.game = null

    $('#vplay').removeClass('disabled')
    $('#mplay').removeClass('disabled')

    if (configuration.launchervis !== 1) {
      ipcRenderer.send('toggle', true)
    } else {
      if (code !== 0) {
        ipcRenderer.send('toggle', true)
        logMsg('stderr', 'Game crashed. Refer to the log above for debugging or reporting.')
        $('.tab[data-tab="log"]').click()
        return
      }
      ipcRenderer.send('close')
    }
  })
}

function checksum (str, algorithm, encoding) {
  return crypto
    .createHash(algorithm || 'md5')
    .update(str)
    .digest(encoding || 'hex')
}

function directoryCheck () {
  try {
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir)
    }
  } catch (e) {
    console.error('Unexpected error while creating data directory')
    console.error(e.stack)
  }

  // Delete any residue
  if (fs.existsSync(tmpdir)) {
    fse.removeSync(tmpdir)
  }
}

const configFile = path.join(dataDir, 'settings.json')

function dataSave () {
  try {
    fs.writeFileSync(configFile, JSON.stringify(configuration, null, '  '))
  } catch (e) {
    console.error(e.stack)
  }
}

function dataFetch () {
  if (!fs.existsSync(configFile)) {
    return dataSave()
  }

  let data = fs.readFileSync(configFile, {encoding: 'utf8'})
  configuration = Object.assign(configuration, JSON.parse(data))

  logMsg('stdout', 'Launcher settings loaded')
}

function addProfile (current, id, mineversion) {
  let name = current.name
  let gameDir = path.join(games, name.replace(/[|&;$%@"<>()+,]/g, '').replace(/\s/g, '_'))

  if (fs.existsSync(gameDir)) {
    gameDir += '_'
  }

  fse.mkdirsSync(gameDir)
  configuration.versions.push({
    id: uuid(),
    name: name,
    version: id,
    mcversion: mineversion,
    game: gameDir,
    added: new Date()
  })

  dataSave()
  refreshHTML()

  return gameDir
}

// Create a directory to store our data
directoryCheck()
dataFetch()

// Validate permgen configuration
if (configuration.permgen > OSMemory) {
  configuration.permgen = OSMemory - 1
  dataSave()
}

if (configuration.permgen < 0) {
  configuration.permgen = 1
  dataSave()
}

const authserver = 'https://authserver.mojang.com'

// Check if the saved access token is still valid
if (!configuration.accessToken) {
  Windowing.switch('#authenticate')
} else {
  $.ajax({
    type: 'POST',
    contentType: "application/json",
    url: authserver + '/validate',
    data: JSON.stringify({
      accessToken: configuration.accessToken,
      clientToken: configuration.client
    }),
    dataType: 'json',
    success: (result, status, jq) => {
      Windowing.switch('#select')
    }
  }).fail((data) => {
    Windowing.switch('#authenticate')
  })
}

// Ask for new tokens (after player exits a game)
function refreshTokens () {
  let payload = {
    clientToken: configuration.client,
    accessToken: configuration.accessToken,
    requestUser: true
  }

  $.ajax({
    type: 'POST',
    contentType: "application/json",
    url: authserver + '/refresh',
    data: JSON.stringify(payload),
    dataType: 'json',
    success: (result, status, jq) => {
      if (!result && !result.clientToken) {
        $('#notice').html('Unexpected error')
        return
      }

      configuration.accessToken = result.accessToken
      if (result.selectedProfile) {
        getPlayerdata(result.selectedProfile.id)
      }

      dataSave()
      Windowing.switch('#select')
    }
  }).fail((data) => {
    Windowing.switch('#authenticate')
    $('#notice').html('You need to log in again.')
  })
}

function getPlayerdata (profileId) {
  if (configuration.user && configuration.user.name) return

  $.ajax({
    type: 'GET',
    url: 'https://sessionserver.mojang.com/session/minecraft/profile/' + profileId,
    dataType: 'json',
    success: (data) => {
      if (!data) return
      configuration.user = data
      dataSave()
    }
  }).fail((e) => {
    console.error(e)
  })
}

// Log in
$('#login').submit((e) => {
  e.preventDefault()

  let email = $('#email').val()
  let password = $('#password').val()

  let payload = {
    agent: {
      name: 'Minecraft',
      version: 1
    },
    username: email,
    password: password,
    clientToken: configuration.client,
    requestUser: true
  }

  $.ajax({
    type: 'POST',
    contentType: "application/json",
    url: authserver + '/authenticate',
    data: JSON.stringify(payload),
    dataType: 'json',
    success: (result, status, jq) => {
      if (!result && !result.clientToken) {
        $('#notice').html('Unexpected error')
        return
      }

      configuration.accessToken = result.accessToken
      if (result.selectedProfile) {
        getPlayerdata(result.selectedProfile.id)
      }

      dataSave()
      Windowing.switch('#select')
    }
  }).fail((data) => {
    $('#notice').html(JSON.parse(data.errorText).errorMessage)
  })
})

// Log out
function logout () {
  $.ajax({
    type: 'POST',
    contentType: "application/json",
    url: authserver + '/invalidate',
    data: JSON.stringify({
      accessToken: configuration.accessToken,
      clientToken: configuration.client
    }),
    dataType: 'json',
    success: (result, status, jq) => {}
  })

  Windowing.switch('#authenticate')

  configuration.accessToken = null
  configuration.user = null
  dataSave()
}

$('#logout').click(logout)
jQuery.fn.tabber = function () {
  let system = $(this)
  let tabber = $(this).data('tab-data')
  tabber = $('#' + tabber)

  let active = tabber.find('.tab.active')

  tabber.find('.tab').each(function () {
    if (!$(this).hasClass('active')) {
      tabber.find('.tab_pane[data-tab="' + $(this).data('tab') + '"]').hide()
    }

    $(this).click(function() {
      let currentPane = tabber.find('.tab_pane[data-tab="' + active.data('tab') + '"]')
      currentPane.hide()
      let pane = tabber.find('.tab_pane[data-tab="' + $(this).data('tab') + '"]')
      pane.show()
      active.removeClass('active')
      active = $(this)
      $(this).addClass('active')
    })
  })
}

$('#navigator').tabber()

function changePermgen (val) {
  $('#permgen').val(val)
  $('#permgen-num').text(val + ' G')
}

function getListMeta (id) {
  for (let i in versionsList) {
    let ver = versionsList[i]
    if (ver.id === id) return ver
  }

  return null
}

let selected = null
let selectedmp = null
let evts = false

function getVersionById (id) {
  for (let i in configuration.versions) {
    if (configuration.versions[i].id === id) {
      return configuration.versions[i]
    }
  }
}

function getModpackById (id) {
  for (let i in configuration.modpacks) {
    if (configuration.modpacks[i].id === id) {
      return configuration.modpacks[i]
    }
  }
}

function deleteVersionSave (id) {
  for (let i in configuration.versions) {
    let save = configuration.versions[i]
    if (save.id === selected) {
      configuration.versions.splice(parseInt(i), 1)
      fse.removeSync(save.game)
    }
  }

  dataSave()
}

function deleteModpackSave () {
  for (let i in configuration.modpacks) {
    let save = configuration.modpacks[i]
    if (save.id === selectedmp) {
      configuration.modpacks.splice(parseInt(i), 1)
      fse.removeSync(save.game)
    }
  }

  dataSave()
}

function deselectMP () {
  selectedmp = null
  $('div[data-tab="modpacks"] .packdata').css('background-image', '')
  $('#mpdata').hide()
}

function refreshHTML () {
  $('#profiles').html('')
  $('#modpacks').html('')
  $('#permgen').attr('max', OSMemory)
  $('#vis').val(configuration.launchervis)

  changePermgen(configuration.permgen)

  $('#jvm').val(configuration.jvm)
  $('#jexec').val(configuration.executable)

  getListVersions((data) => {
    versionsList = data
  })

  for (let i in configuration.versions) {
    let version = configuration.versions[i]
    let tmpl = $($('#instmpl').text()).clone()

    $('#profiles').append(tmpl.attr('id', version.id))

    tmpl.find('#name').text(version.name)
    tmpl.find('#version').text(version.version)
    tmpl.click(function() {
      if (selected) {
        $('#profiles').find('#' + selected).removeClass('selected')

        if (selected === $(this).attr('id')) {
          selected = null
          $('#selectedver').text('')
          return
        }
      }

      $('.vpbtn').show()
      $('#selectedver').text(version.name)

      $(this).addClass('selected')
      selected = $(this).attr('id')
    })
  }

  for (let i in configuration.modpacks) {
    let version = configuration.modpacks[i]
    let tmpl = $($('#instmpl').text()).clone()

    tmpl.addClass(version.source)
    $('#modpacks').append(tmpl.attr('id', version.id))

    tmpl.find('#name').text(version.meta.name)
    tmpl.find('#version').text(version.meta.version)
    tmpl.click(function() {
      if (selectedmp) {
        $('#modpacks').find('#' + selectedmp).removeClass('selected')

        if (selectedmp === $(this).attr('id')) return deselectMP()
      }
      deselectMP()

      $('#selectedmp').text(version.meta.name)
      $('#mpversion').text(version.meta.version)
      $('#mpmcversion').text(version.mcversion)
      $('#mpauthor').text(version.meta.author)
      $('#mpdata').show()
      if (version.source === 'custom') {
        $('#mreinstall').hide()
      } else {
        $('#mreinstall').show()
      }

      if (version.meta.images) {
        if (version.meta.images.background) {
          $('div[data-tab="modpacks"] .packdata').css('background-image', 'url(' + version.meta.images.background.url + ')')
        }
      }

      $(this).addClass('selected')
      selectedmp = $(this).attr('id')
    })
  }

  // Make sure events are bound only once
  if (evts) return
  evts = true

  $('#permgen').change(function () {
    changePermgen($(this).val())
  })

  $('#vplay').click(function () {
    if (currentProgram.process) return
    if ($(this).hasClass('disabled')) return
    if (!selected) return
    let game = getVersionById(selected)

    if (game) {
      queue.push({
        type: 'prelaunch',
        game: game
      })
      queuePump()
    }

    $(this).addClass('disabled')
  })

  $('#mplay').click(function () {
    if (currentProgram.process) return
    if ($(this).hasClass('disabled')) return
    if (!selectedmp) return
    let game = getModpackById(selectedmp)

    if (game) {
      queue.push({
        type: 'prelaunch',
        game: game
      })
      queuePump()
    }

    $(this).addClass('disabled')
  })

  $('#mreinstall').click(function () {
    if (currentProgram.process) return
    if ($(this).hasClass('disabled')) return
    if (!selectedmp) return
    let game = getModpackById(selectedmp)
    deselectMP()

    if (game) {
      queue.push({
        type: 'modpack',
        url: game.meta.url
      })
      queuePump()
    }
  })

  $('#vremove').click(function() {
    if (currentProgram.process) return
    if (!selected) return

    dialog.pop('Are you sure?', 'Are you sure you want to delete this version? \
      <br>Your saves on this version will be lost <b>forever</b> (a very long time!)\
      <div style="text-align:center;"><button id="confirm">Yes, I don\'t care.</button>\
      <button id="cancel">No, get me out of here!</button></div>')

    $('.dialog #confirm').click(function() {
      deleteVersionSave(selected)

      selected = null
      $('.vpbtn').hide()
      $('#selectedver').text('')

      dialog.close()
      refreshHTML()
    })

    $('.dialog #cancel').click(function() {
      dialog.close()
    })
  })

  $('#mremove').click(function() {
    if (currentProgram.process) return
    if (!selectedmp) return

    dialog.pop('Are you sure?', 'Are you sure you want to delete this modpack? \
      <br>Your saves on this modpack will be lost <b>forever</b> (a very long time!)\
      <div style="text-align:center;"><button id="confirm">Yes, I don\'t care.</button>\
      <button id="cancel">No, get me out of here!</button></div>')

    $('.dialog #confirm').click(function() {
      deleteModpackSave()

      deselectMP()

      dialog.close()
      refreshHTML()
    })

    $('.dialog #cancel').click(function() {
      dialog.close()
    })
  })

  $('#vadd').click(function () {
    addDialog()
  })

  $('#madd').click(function () {
    installModpack()
  })

  $('#mnew').click(function () {
    createModpack()
  })

  $('#maddmod').click(function () {
    if (!selectedmp) return
    manageMods(selectedmp)
  })

  $('#devtools').click(function () {
    ipcRenderer.send('developer')
  })

  $('#clearlog').click(function () {
    $('#log').html('')
  })
}

function flashMsg (elem, msg, time = 2000) {
  $(elem).text(msg)
  setTimeout(() => {
    $(elem).text('')
  }, time)
}

$('#run_settings').submit(function (e) {
  e.preventDefault()
  let permgen = parseFloat($('#permgen').val())
  let jvm = $('#jvm').val()
  let vis = $('#vis').val()
  let jexec = $('#jexec').val()

  if (!isNaN(permgen)) {
    if (permgen > OSMemory) {
      configuration.permgen = OSMemory - 1
    } else if (permgen < 0) {
      configuration.permgen = 1
    } else {
      configuration.permgen = permgen
    }
  }

  if (jvm) {
    configuration.jvm = jvm
  }

  if (jexec) {
    configuration.executable = jexec
  }

  configuration.launchervis = parseInt(vis)
  if (isNaN(configuration.launchervis)) {
    configuration.launchervis = 0
  }

  flashMsg('#save_msg', 'Saved!')

  dataSave()
})

$(document).ready(function() {
  refreshHTML()
})

let download = function (url, dest, cb) {
  let http = url.indexOf('https') === 0 ? require('https') : require('http')
  let file = fs.createWriteStream(dest)
  let request = http.get(url, function(response) {
    response.pipe(file)
    file.on('finish', function() {
      if (response.statusCode === 302) return download(response.headers['location'], dest, cb)
      if (response.statusCode === 404) {
        return file.close(() => {
          fse.removeSync(dest)
          cb('File not found')
        })
      }
      file.close(cb)  // close() is async, call cb after close completes.
    })
  }).on('error', function(err) { // Handle errors
    fs.unlink(dest) // Delete the file async. (But we don't check the result)
    if (cb) cb(err.message)
  })
}

function forgeVersionLayout (mcv, fv) {
  let forgeLayout = mcv + '-' + fv
  let mcver = mcv.match(/\d+/g)

  if (mcver[1] && parseInt(mcver[1]) <= 9 && parseInt(mcver[1]) > 6) {
    if (mcver[2] && parseInt(mcver[1]) === 9) return forgeLayout
    let trailing = mcv

    if (!mcver[2]) trailing += '.0'

    forgeLayout = mcv + '-' + fv + '-' + trailing
  }

  return forgeLayout
}

function unpackForgeLibPack (inputFile, cbfull) {
  let outFile = inputFile.replace('.xz', '')

  let decompressor = lzma.createDecompressor()
  let xz = fs.createReadStream(inputFile)
  let pack = fs.createWriteStream(outFile)

  async.waterfall([
    function (cb) {
      xz.pipe(decompressor).pipe(pack).on('error', (e) => {
          cb(e)
      }).on('close', () => {
          cb()
      })
    },
    function (cb) {
      let data = fs.readFileSync(outFile)
      let signstr = Buffer.from(data.slice(data.length - 4)).toString()

      if (signstr !== 'SIGN') {
        return cb(new Error('Signature missing!'))
      }

      let x = data.length;
      let len =
              ((data[x - 8] & 0xFF)      ) |
              ((data[x - 7] & 0xFF) << 8 ) |
              ((data[x - 6] & 0xFF) << 16) |
              ((data[x - 5] & 0xFF) << 24)

      let packFileNew = path.join(tmpdir, 'output.pack')
      let write = fs.createWriteStream(packFileNew)
      let checksums = Buffer.from(data.slice(data.length - len - 8)).toString()

      write.write(Buffer.from(data.slice(0, data.length - len - 8)))
      write.close()

      fse.removeSync(outFile)
      fs.renameSync(packFileNew, outFile)

      write.on('close', () => {
        cb(null, outFile, checksums)
      })
    },
    function (fname, checksums, cb) {
      let checksumsSane = {}
      try {
        let checksumsRaw = checksums.split('\n')
        checksumsRaw.splice(checksumsRaw.length - 1, 1)
        for (let i in checksumsRaw) {
          let fp = checksumsRaw[i].split(' ')
          checksumsSane[fp[1]] = fp[0]
        }
      } catch (e) {
        return cb(new Error('Corrupt signature!'))
      }
      cb(null, fname, checksumsSane)
    },
    function (fname, checksums, cb) {
      let outFile = fname.replace('.pack', '')

      // TODO: port unpack200 to JavaScript
      try {
        let proc = childprocess.spawn('unpack200', [fname, outFile])
        let errorMsgs = []
        proc.stdout.on('data', (data) => {
          errorMsgs.push(data.toString())
        })
        proc.on('close', (code) => {
          if (code != 0) {
            return cb(new Error('unpack200 failed: ' + errorMsgs.join('\n')))
          }
          fse.removeSync(fname)
          cb(null, outFile, checksums)
        })
      } catch (e) {
        console.error(e)
        cb(new Error('unpack200 is not installed! Make sure the JDK is in your $PATH'))
      }
    },
    function (fname, checksums, cb) {
      // Decompress jar
      let decomp = path.join(__dirname, '.tmpdr')
      fs.mkdirSync(decomp)
      extractZip(fname, {dir: decomp}, (e) => {
        cb(e, fname, checksums, decomp)
      })
    },
    function (fname, checksums, decomp, cb) {
      // checksums
      for (let file in checksums) {
        let check = checksums[file]
        let fpth = path.join(decomp, file)

        if (!fs.existsSync(fpth)) {
          return cb(new Error(fpth + ' is missing!'))
        }

        let fdata = fs.readFileSync(fpth)
        if (checksum(fdata, 'sha1') !== check) {
          return cb(new Error('Checksums do not match.'))
        }
      }
      fse.removeSync(decomp)
      let jard = fs.readFileSync(fname)
      cb(null, fname)
    },
    function (file, cb) {
      cbfull(null, file)
    }
  ], (e) => {
    cbfull(e)
  })
}

function queueProgressError (error) {
  dialog.pop('Download error', 'A fatal error occured:<br>' + error)
  dialog.setClosePossible(true)

  console.error(error)

  if (fs.existsSync(tmpdir)) {
    fse.removeSync(tmpdir)
  }

  queue = []
  queuePump()
}

function queuePump () {
  if (!queue.length) return

  let current = queue[0]
  if (current.active == true) return
  queue[0].active = true

  if (current.type === 'version') {
    if (!fs.existsSync(versions)) {
      fs.mkdirSync(versions)
    }

    dialog.pop('Downloading in progress', '<span id="content_progress">Waiting..</span>')
    dialog.setClosePossible(false)

    // Get URL for version
    if (!current.url) {
      let versionUrl = getListMeta(current.id)
      if (versionUrl.url) {
        current.url = versionUrl.url
      }
    }

    async.waterfall([
      function (callback) {
        let versionDir = path.join(versions, current.id)
        if (fs.existsSync(versionDir)) return callback()
        fs.mkdirSync(versionDir)
        callback(null)
      },
      function (callback) {
        $('#dialog #content_progress').text('Downloading version metadata')
        $.ajax({
          type: 'GET',
          url: current.url,
          dataType: 'json',
          success: function (data) {
            fs.writeFileSync(path.join(versions, current.id, current.id + '.json'), JSON.stringify(data, null, '  '))
            callback(null, data)
          }
        }).fail(() => {
          queueProgressError('Could not download metadata.')
        })
      },
      function (versionMeta, callback) {
        $('#dialog #content_progress').text('Downloading assets')
        if (!fs.existsSync(assets)) {
          fs.mkdirSync(assets)
          fs.mkdirSync(path.join(assets, 'indexes'))
          fs.mkdirSync(path.join(assets, 'objects'))
        }

        let metaFile = path.join(assets, 'indexes', versionMeta.id + '.json')
        if (!fs.existsSync(metaFile)) {
          return callback(null, versionMeta, null)
        }

        let data = fs.readFileSync(metaFile, {encoding: 'utf8'})
        data = JSON.parse(data)

        callback(null, versionMeta, data)
      },
      function (versionMeta, existing, callback) {
        if (existing) return callback(null, existing, versionMeta)
        $('#dialog #content_progress').text('Downloading assets indexes')
        $.ajax({
          type: 'GET',
          dataType: 'json',
          url: versionMeta.assetIndex.url,
          success: function (resp) {
            fs.writeFileSync(path.join(assets, 'indexes', versionMeta.assetIndex.id + '.json'), JSON.stringify(resp, null, '  '))
            callback(null, resp, versionMeta)
          }
        }).fail(() => {
          callback(new Error('An error occured while downloading asset indexes.'))
        })
      },
      function (assetIndexes, versionMeta, callback) {
        $('#dialog #content_progress').html('Downloading assets..')

        let dataOnly = []

        function saveAsset (obj, cb) {
          let dir = path.join(assets, 'objects', obj.hash.substring(0, 2))

          if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir)
          }

          let hashPath = path.join(dir, obj.hash)
          if (fs.existsSync(hashPath)) {
            return cb(null)
          }

          let rootUri = 'http://resources.download.minecraft.net/'

          download(rootUri + obj.hash.substring(0, 2) + '/' + obj.hash, hashPath, cb)
        }

        function downloadAsset (idx) {
          $('#dialog #content_progress').html('Downloading asset ' + (idx + 1) + ' of ' + dataOnly.length + '..')

          let assetData = dataOnly[idx]

          saveAsset(assetData, (e) => {
            if (e) {
              return callback(new Error('An error occured while downloading asset.'))
            }

            if (dataOnly.length === idx + 1) return callback(null, versionMeta)
            downloadAsset(idx + 1)
          })
        }

        for (let i in assetIndexes.objects) {
          dataOnly.push(assetIndexes.objects[i])
        }

        downloadAsset(0)
      },
      function (versionMeta, callback) {
        $('#dialog #content_progress').text('Downloading game jar..')
        let verJar = path.join(versions, versionMeta.id, versionMeta.id + '.jar')

        if (fs.existsSync(verJar)) {
          $('#dialog #content_progress').text('JAR exists, verifying integrity..')
          let data = fs.readFileSync(verJar)
          if (checksum(data, 'sha1') === versionMeta.downloads.client.url) {
            return callback(null)
          }
        }

        download(versionMeta.downloads.client.url, verJar, (e) => {
          if (e) return callback(new Error('An error occured while downloading game jar.'))
          callback(null)
        })
      },
      function (callback) {
        dialog.pop('Downloading finished', 'Done.')
        dialog.setClosePossible(true)

        if (current.profile !== false && current.name) {
          addProfile(current, current.id, current.id)
        }

        // Remove this entry
        queue.splice(0, 1)

        // Add one for downloading the libraries
        queue.push({
          type: 'libraries',
          version: current.id
        })
        queuePump()
      }
    ], (err) => {
      queueProgressError(err.message)
    })
  } else if (current.type === 'libraries') {
    dialog.pop('Validating libraries', '<span id="content_progress">Waiting..</span>')
    dialog.setClosePossible(false)

    async.waterfall([
      function (callback) {
        let versionDir = path.join(versions, current.version)
        let metaFile = path.join(versionDir, current.version + '.json')
        if (!fs.existsSync(versionDir)) return callback(new Error('No such version installed.'))
        if (!fs.existsSync(metaFile)) return callback(new Error('Version metadata missing.'))
        let data = fs.readFileSync(metaFile, {encoding: 'utf8'})
        data = JSON.parse(data)
        callback(null, data)
      },
      function (meta, callback) {
        if (!fs.existsSync(libraries)) {
          fs.mkdirSync(libraries)
        }

        callback(null, meta)
      },
      function (meta, callback) {
        $('#dialog #content_progress').html('Library identity check commencing..')

        // Download artifact
        function downloadDescriptor (name, artifact, cb, needsDownload = false) {
          $('#dialog #content_progress').html('Artifact ' + name + ' perparing..')
          let artiNameSplit = name.split(':')

          let libName = artiNameSplit[1]
          let libVer = artiNameSplit[2]

          let artiPath = artifact.path.split('/')
          let jar = artiPath.splice(-1)[0]

          let artiPathJoined = path.join(libraries, artiPath.join('/'))

          let pathResolve = path.join(libraries, artiPath.join('/'))
          fse.mkdirsSync(pathResolve)

          let jarpath = path.join(artiPathJoined, jar)
          let forgeSpecial = null
          let url = artifact.url

          // Download .pack.xz file instead of .jar when required
          if (artifact.lzma) {
            if (!fs.existsSync(tmpdir)) {
              fse.mkdirsSync(tmpdir)
            }

            forgeSpecial = path.join(tmpdir, jar + '.pack.xz')
            url += '.pack.xz'
          }

          function checksumIt (e) {
            if (artifact.sha1) {
              let data = fs.readFileSync(jarpath)
              if (checksum(data, 'sha1') !== artifact.sha1) {
                return downloadDescriptor(name, artifact, cb, true)
              }
            }
            cb(e, jarpath)
          }

          if (!fs.existsSync(jarpath) || needsDownload) {
            $('#dialog #content_progress').html('Downloading library ' + name)
            download(url, forgeSpecial || jarpath, (e) => {
              if (e) return cb(e)

              if (forgeSpecial) {
                // Unpack .pack.xz
                // We'll need to port the unpack200 program to JavaScript at one point,
                // right now, the JDK is required.
                $('#dialog #content_progress').html('Extracting library ' + name)
                return unpackForgeLibPack(forgeSpecial, (err, returnedJar) => {
                  if (err) return cb(err)
                  fs.renameSync(returnedJar, jarpath)
                  fse.removeSync(forgeSpecial)
                  cb(null, jarpath)
                })
              }

              checksumIt(e)
            })
          } else {
            checksumIt(null)
          }
        }

        function checkLib (idx) {
          let lib = meta.libraries[idx]
          let skip = false

          // Check OS-specific rules
          if (lib.rules) {
            for (let i in lib.rules) {
              let rule = lib.rules[i]
              if (rule.action && !rule.os) continue
              if (rule.action === 'disallow' && rule.os.name === platform) {
                skip = true
                break
              }

              if (rule.action === 'allow' && rule.os.name !== platform) {
                skip = true
                break
              }
            }
          }

          if (skip) {
            if (idx + 1 === meta.libraries.length) return callback(null, meta)
            return checkLib(idx + 1)
          }

          if (lib.downloads) {
            let dlqueue = []

            // Waterfall the downloading of artifacts and natives
            async.waterfall([
              function (cb) {
                if (lib.downloads.artifact) {
                  let artifact = lib.downloads.artifact
                  return downloadDescriptor(lib.name, artifact, (err, filePath) => {
                    if (err) return callback(err)
                    cb(null)
                  })
                }
                cb(null)
              },
              function (cb) {
                if (lib.natives) {
                  if (lib.natives[platform] != null) {
                    let natives = lib.downloads.classifiers['natives-' + platform]
                    if (!natives) return callback(new Error('Inconsistencies within metadata.'))
                    return downloadDescriptor(lib.name, natives, (err, filePath) => {
                      if (err) return callback(err)
                      cb(null)
                    })
                  }
                }
                cb(null)
              },
              function (cb) {
                if (idx + 1 === meta.libraries.length) return callback(null, meta)
                checkLib(idx + 1)
              }
            ])
          }
        }

        checkLib(0)
      },
      function (meta, callback) {
        dialog.pop('Success', 'All done!')
        dialog.setClosePossible(true)

        queue.splice(0, 1)
        queuePump()
      }
    ], (err) => {
      queueProgressError(err.message)
    })
  } else if (current.type === 'prelaunch') {
    queue.push({
      type: 'libraries',
      version: current.game.version
    })
    queue.push({
      type: 'natives',
      game: current.game
    })

    queue.splice(0, 1)
    queuePump()
  } else if (current.type === 'natives') {
    dialog.pop('Extracting', '<span id="content_progress">Extracting natives</span>')
    dialog.setClosePossible(false)

    let nativeTime = Date.now()
    async.waterfall([
      function (cb) {
        // Create the directory required for natives
        let nativesDir = path.join(versions, current.game.version, 'natives-' + nativeTime)
        fs.mkdirSync(nativesDir)

        let versionMeta = path.join(versions, current.game.version, current.game.version + '.json')
        let data = fs.readFileSync(versionMeta, {encoding: 'utf8'})
        data = JSON.parse(data)

        cb(null, nativesDir, data)
      },
      function (nativesDir, versionMeta, cb) {
        // Separate libraries with natives for extraction
        let libs = []
        for (let i in versionMeta.libraries) {
          let lib = versionMeta.libraries[i]
          let skip = false

          if (lib.rules) {
            for (let i in lib.rules) {
              let rule = lib.rules[i]
              if (rule.action && !rule.os) continue
              if (rule.action === 'disallow' && rule.os.name === platform) {
                skip = true
                break
              }

              if (rule.action === 'allow' && rule.os.name !== platform) {
                skip = true
                break
              }
            }
          }

          if (skip) continue

          if (lib.natives && lib.extract) {
            if (!lib.natives[platform]) continue
            libs.push(lib)
          }
        }

        let extractedFiles = []
        for (let i in libs) {
          let lib = libs[i]
          let native = lib.downloads.classifiers['natives-' + platform]
          if (!native) continue

          extractedFiles.push(path.join(libraries, native.path))
        }

        cb(null, nativesDir, extractedFiles, versionMeta)
      },
      function (nativesDir, extractedFiles, versionMeta, cb) {
        function hitNative (index) {
          extractZip(extractedFiles[index], {dir: nativesDir}, (err) => {
            if (err) return cb(err)
            if (fs.existsSync(path.join(nativesDir, 'META-INF'))) {
              fse.removeSync(path.join(nativesDir, 'META-INF'))
            }

            if (index + 1 === extractedFiles.length) return cb(null, nativesDir, versionMeta)
            hitNative(index + 1)
          })
        }

        hitNative(0)
      },
      function (nativesDir, versionMeta) {
        dialog.close()
        currentProgram.natives = nativesDir
        queue.splice(0, 1)
        queue.push({
          type: 'boot',
          game: current.game
        })
        queuePump()
      }
    ])
  } else if (current.type === 'boot') {
    let versionMeta = path.join(versions, current.game.version, current.game.version + '.json')
    versionMeta = fse.readJsonSync(versionMeta)
    let libfiles = []
    for (let i in versionMeta.libraries) {
      let lib = versionMeta.libraries[i]
      let skip = false

      if (lib.rules) {
        for (let j in lib.rules) {
          let rule = lib.rules[j]
          if (rule.action && !rule.os) continue
          if (rule.action === 'disallow' && rule.os.name === platform) {
            skip = true
            break
          }

          if (rule.action === 'allow' && rule.os.name !== platform) {
            skip = true
            break
          }
        }
      }

      if (skip) continue
      if (!lib.downloads || !lib.downloads.artifact) continue
      libfiles.push(path.join(libraries, lib.downloads.artifact.path))
    }

    let launchOpts = {
      class: versionMeta.mainClass,
      args: versionMeta.minecraftArguments,
      assetIndex: versionMeta.assetIndex.id
    }

    currentProgram.libraries = libfiles

    launch(current.game, launchOpts)

    queue.splice(0, 1)
    queuePump()
  } else if (current.type === 'forge') {
    if (!current.version || !current.forgever) return
    let mcv = current.version
    let fv = current.forgever

    let mclib = 'https://libraries.minecraft.net/'
    let fgmvn = 'http://files.minecraftforge.net/maven/'

    let forgeName = forgeVersionLayout(mcv, fv)
    let versionDir = path.join(versions, mcv)

    async.waterfall([
      function (cb) {
        if (!fs.existsSync(versionDir)) {
          queue[0].active = false
          queue.unshift({
            type: 'version',
            id: mcv,
            profile: false,
            type: 'version'
          })
          queuePump()
          return
        }

        if (fv.indexOf('forge-') === 0) {
          fv = fv.substring('forge-'.length)
        }

        dialog.pop('Downloading Forge', '<span id="content_progress">Getting version ' + fv + '</span>')
        dialog.setClosePossible(false)

        if (!fs.existsSync(tmpdir)) {
          fs.mkdirSync(tmpdir)
        }
        cb()
      },
      function (cb) {
        let jarurl = fgmvn + 'net/minecraftforge/forge/' + forgeName + '/forge-' + forgeName + '-universal.jar'
        let jarfile = path.join(tmpdir, 'forge-' + forgeName + '-universal.jar')

        if (fs.existsSync(jarfile)) {
          return cb(null, jarfile)
        }

        download(jarurl, jarfile, (err) => {
          if (err) return cb(err)
          cb(null, jarfile)
        })
      },
      function (jar, cb) {
        $('#dialog #content_progress').html('Extracting..')
        let extrdir = path.join(tmpdir, 'forge-extract')
        fse.mkdirsSync(extrdir)

        extractZip(jar, {dir: extrdir}, (err) => {
          cb(err, jar, extrdir)
        })
      },
      function (jar, extrdir, cb) {
        $('#dialog #content_progress').html('Parsing data..')
        let versionjson = path.join(extrdir, 'version.json')
        let data
        try {
          data = fs.readFileSync(versionjson, {encoding: 'utf8'})
          data = JSON.parse(data)
        } catch (e) {
          return cb(new Error('Extraction failed!'))
        }
        if (!data) return cb(new Error('Extraction failed!'))

        let dataobj = {
          id: data.id,
          vanillaVersion: data.jar,
          args: data.minecraftArguments,
          class: data.mainClass
        }

        // Standardize the forge libraries so that the launchers 'libraries' task can download them
        let libs2 = []
        for (let i in data.libraries) {
          let lib = data.libraries[i]
          let nsplit = lib.name.split(':')

          if (lib.serverreq === true && lib.clientreq === null) continue
          if (lib.clientreq === false) continue

          // Lib Path builder
          let fpath = nsplit[0].split('.')
          fpath.push(nsplit[1])
          fpath.push(nsplit[2])
          fpath.push(nsplit[1] + '-' + nsplit[2] + '.jar')
          fpath = fpath.join('/')

          // Lib URL builder
          let url
          if (lib.url) {
            if (nsplit[1] === 'forge') {
              // A hack around, need to download the universal jar!
              let forgePath = nsplit[0].split('.')
              forgePath.push(nsplit[1])
              forgePath.push(nsplit[2])
              forgePath.push(nsplit[1] + '-' + nsplit[2] + '-universal.jar')
              url = lib.url + forgePath.join('/')
            } else {
              url = lib.url + fpath
            }
          } else {
            url = mclib + fpath
          }

          // The artifacts with two checksums are .pack.xz files
          let sha1 = lib.checksums
          let requiresLZMA = false
          if (sha1) {
            if (sha1.length > 1) {
              sha1 = null
              requiresLZMA = true
            } else {
              sha1 = lib.checksums[0]
            }
          }

          libs2.push({
            name: lib.name,
            downloads: {
              artifact: {
                lzma: requiresLZMA,
                url: url,
                path: fpath,
                sha1: sha1
              }
            }
          })
        }
        cb(null, libs2, dataobj, extrdir)
      },
      function (libs2, fdata, extrdir, cb) {
        $('#dialog #content_progress').html('Cleaning up..')
        fse.removeSync(extrdir)
        fse.removeSync(tmpdir)

        $('#dialog #content_progress').html('Creating forge version directory..')
        let fvdir = path.join(versions, fdata.id)
        if (fs.existsSync(fvdir)) {
          fse.removeSync(fvdir)
        }

        let verjson = path.join(fvdir, fdata.id + '.json')

        // Create forge version dir
        fse.copySync(versionDir, fvdir)
        fs.renameSync(path.join(fvdir, mcv + '.json'), verjson)
        fs.renameSync(path.join(fvdir, mcv + '.jar'), path.join(fvdir, fdata.id + '.jar'))

        // Modify version.json
        let crdr = fse.readJsonSync(verjson)
        crdr.minecraftArguments = fdata.args
        crdr.mainClass = fdata.class
        crdr.id = fdata.id
        crdr.libraries = crdr.libraries.concat(libs2)
        fse.writeJSONSync(verjson, crdr)
        cb(null, fdata.id)
      },
      function (id, cb) {
        dialog.pop('Forge Done', '<span id="content_progress">Forge ' + id + ' installed!</span>')
        dialog.setClosePossible(true)

        queue.push({
          type: 'libraries',
          version: id
        })

        if (current.profile !== false && current.name) {
          let name = current.name
          let mpgamedir = path.resolve(path.join(games, name.replace(/\s+/g, '_')))
          fse.mkdirsSync(mpgamedir)

          let mpfind = null
          for (let i in configuration.modpacks) {
            let mpi = configuration.modpacks[i]
            if (mpi.name === name) {
              mpfind = i
            }
          }

          // Modpack data profile
          let packdata = {
            id: uuid(),
            name: name,
            version: id,
            mcversion: mcv,
            game: mpgamedir,
            meta: {
              name: name,
              version: 'custom',
              author: configuration.user.name,
              url: null
            },
            source: 'custom',
            added: new Date()
          }

          if (mpfind != null) {
            configuration.modpacks[mpfind] = packdata
          } else {
            configuration.modpacks.push(packdata)
          }

          dataSave()
          refreshHTML()
        }

        queue.splice(0, 1)
        queuePump()
      }
    ], (err) => {
      queueProgressError(err)
    })
  } else if (current.type === 'modpack') {
    let mpType = null

    if (!current.url) {
      if (current.name) {
        mpType = 'custom'
      }
    } else {
      if (current.url.indexOf('curseforge.com') !== -1) {
        mpType = 'curse'
      } else if (current.url.indexOf('api.technicpack.net') !== -1) {
        mpType = 'technic'
      }
    }

    if (!mpType) {
     $('#dialog #message').html('Unsupported modpack provider.')
     return
    }

    queue.push({
      type: mpType,
      meta: current
    })

    queue.splice(0, 1)
    queuePump()
  } else if (current.type === 'curse') {
    dialog.pop('CurseForge Modpack', '<span id="content_progress">Preparing to install</span>')
    dialog.setClosePossible(false)

    $('#dialog #content_progress').html('Downloading pack..')

    if (!fs.existsSync(tmpdir)) {
      fse.mkdirsSync(tmpdir)
    }

    let url = current.meta.url

    async.waterfall([
      function (cb) {
        curse.hitFile(url + '/files/latest', tmpdir, 'download', (err, filename) => {
          if (err) return cb(err)

          if (filename.indexOf('.zip') === -1) {
            return cb('Unsupported archive: Most likely not a modpack.')
          }

          let mpName = filename.replace('.zip', '')
          let fpath = path.join(tmpdir, filename)

          $('#dialog #content_progress').html('Extracting file..')

          let extracted = path.join(tmpdir, 'curse-download')
          fs.mkdirSync(extracted)

          extractZip(fpath, {dir: extracted}, (err) => {
            fse.removeSync(fpath)
            cb(err, mpName, extracted)
          })
        })
      },
      function (modpackName, extractedData, cb) {
        $('#dialog #content_progress').html('Looking for manifest..')

        let manifest
        try {
          manifest = fse.readJsonSync(path.join(extractedData, 'manifest.json'))
        } catch (e) {
          return cb(new Error('Manifest not found: Most likely not a modpack.'))
        }

        if (!manifest.manifestType || !manifest.manifestType === 'minecraftModpack') {
          return cb(new Error('Invalid Manifest: Most likely not a minecraft modpack.'))
        }

        if (manifest.manifestVersion !== 1) {
          return cb(new Error('Invalid Manifest: Not supported.<br>Please check for launcher updates.'))
        }

        let mcversion = manifest.minecraft.version
        let forge = null
        for (let i in manifest.minecraft.modLoaders) {
          let mloader = manifest.minecraft.modLoaders[i]
          if (mloader.id.indexOf('forge') === 0) {
            forge = mloader.id.substring(6)
          }
        }

        if (forge) {
          queue.push({
            type: 'forge',
            forgever: forge,
            version: mcversion,
            profile: false
          })
        }

        cb(null, manifest.name, manifest, extractedData, forge)
      },
      function (modpackName, metadata, extractedData, forge, cb) {
        $('#dialog #content_progress').html('Starting downloading of files')
        if (!metadata.files) return cb(null, modpackName, metadata, forge)
        dialog.pop('CurseForge Modpack Downloading', '<span id="content_progress">\
          <p id="filename"></p>\
          <div class="progress"><div class="progress-bar" id="progbar_file"></div></div>\
          <p id="modpackName"></p>\
          <div class="progress"><div class="progress-bar" id="progbar_pack"></div></div>\
          <p id="skipped"></p>\
          </span>')
        dialog.setClosePossible(false)
        $('.dialog #modpackName').text('Installing ' + metadata.name)

        let mpgamedir = path.resolve(path.join(games, modpackName.replace(/\s+/g, '_')))
        if (fs.existsSync(mpgamedir)) {
          if (fs.existsSync(path.join(mpgamedir, 'config'))) {
            fse.removeSync(path.join(mpgamedir, 'config'))
          }

          if (fs.existsSync(path.join(mpgamedir, 'mods'))) {
            fse.removeSync(path.join(mpgamedir, 'mods'))
          }
        }

        let modsDir = path.join(mpgamedir, 'mods')
        fse.mkdirsSync(modsDir)

        let total = metadata.files.length
        let skipped = 0

        function hitFile (index) {
          let installPercent = (((index + 1) / total) * 100).toFixed(2)
          let file = metadata.files[index]
          let filetotal = 0
          let fName = ''

          $('.dialog #progbar_pack').css('width', installPercent + '%')
          $('.dialog #modpackName').text('Installing ' + metadata.name + ' - File ' + (index + 1) + ' of ' +
            total + ' ' + installPercent + '%')

          if (skipped != 0) {
            $('.dialog #skipped').text(skipped + ' mod(s) were skipped because they couldn\'t be found!')
          }

          curse.curseFile(file.projectID, file.fileID, modsDir, (err, filename) => {
            if (err) {
              console.error(err)
              skipped += 1
            }
            if (index + 1 === total) return cb(null, modpackName, metadata, extractedData, forge, mpgamedir)

            if (!err) {
              $('.dialog #filename').text(fName + ' - 100% ' + filetotal + ' out of ' + filetotal + ' MB')
              $('.dialog #progbar_file').css('width', '100%')
            }

            hitFile(index + 1)
          }, (fileName, percent, mb, mbtotal) => {
            filetotal = mbtotal
            fName = fileName
            $('.dialog #filename').text(fileName + ' - ' + percent + '% ' + mb + ' MB out of ' + mbtotal + ' MB')
            $('.dialog #progbar_file').css('width', percent + '%')
          })
        }

        hitFile(0)
      },
      function (modpackName, metadata, extractedData, forge, mpgamedir, cb) {
        dialog.pop('CurseForge Modpack', '<span id="content_progress">Finishing up..</span>')
        dialog.setClosePossible(false)

        if (metadata.overrides) {
          let overrides = path.join(extractedData, metadata.overrides)
          if (fs.existsSync(overrides)) {
            curse.patchDirs(mpgamedir, overrides)
          }
        }

        // Move the manifest
        fs.renameSync(path.join(extractedData, 'manifest.json'), path.join(mpgamedir, 'manifest.json'))

        // Remove the data directory we extracted
        fse.removeSync(extractedData)

        // Create forge version name ${mcver}-forge${mcver}-${forge}
        let mcver = metadata.minecraft.version
        forge = mcver + '-forge' + mcver + '-' + forge

        $('#dialog #content_progress').html('Creating profile..')
        let mpfind = null
        for (let i in configuration.modpacks) {
          let mpi = configuration.modpacks[i]
          if (mpi.name === modpackName) {
            mpfind = i
          }
        }

        // Modpack data profile
        let packdata = {
          id: uuid(),
          name: modpackName,
          version: forge,
          mcversion: mcver,
          game: mpgamedir,
          meta: {
            name: metadata.name,
            version: metadata.version,
            author: metadata.author,
            url: url
          },
          source: 'curse',
          added: new Date()
        }

        if (mpfind != null) {
          configuration.modpacks[mpfind] = packdata
        }

        configuration.modpacks.push(packdata)

        dataSave()
        refreshHTML()
        cb(null)
      },
      function (cb) {
        dialog.pop('CurseForge Modpack', '<span id="content_progress">Done!</span>')
        dialog.setClosePossible(true)

        fse.removeSync(tmpdir)

        queue.splice(0, 1)
        queuePump()
      }
    ], (err) => {
      queueProgressError(err)
    })
  } else if (current.type === 'custom') {
    queue.push({
      type: 'forge',
      profile: true,
      name: current.meta.name,
      version: current.meta.mcversion,
      forgever: current.meta.forge
    })
    queue.splice(0, 1)
    queuePump()
  } else if (current.type === 'technic') {
    dialog.pop('Technic Platform Modpack', '<span id="content_progress">Preparing to install</span>')
    dialog.setClosePossible(false)

    if (!fs.existsSync(tmpdir)) {
      fse.mkdirsSync(tmpdir)
    }

    let url = current.meta.url

    let skipping = false
    if (current.game && current.packMeta) {
      skipping = true
    }

    async.waterfall([
      function (cb) {
        if (skipping) return cb(null, null)
        $.ajax({
          type: 'GET',
          dataType: 'json',
          url: 'http://api.technicpack.net/launcher/version/stable4',
          success: (data) => {
            if (data.build) {
              return cb(null, data.build)
            }
            cb(new Error('Technic Platform is currently unsupported.'))
          }
        })
      },
      function (buildNumber, cb) {
        if (skipping) return cb(null, current.packMeta)
        $.ajax({
          type: 'GET',
          dataType: 'json',
          url: url + '?build=' + buildNumber,
          success: (data) => {
            if (data.error) {
              return cb(new Error('Modpack does not exist.'))
            }
            cb(null, data)
          }
        })
      },
      function (packMeta, cb) {
        if (skipping) return cb(null, current.packMeta, current.game)
        if (packMeta.solder) {
          return cb(new Error('Solder is currently not supported by the launcher.'))
        }

        let downloadUrl = packMeta.url
        let workname = packMeta.name
        let game = path.join(games, workname)
        let zip = path.join(tmpdir, workname + '.zip')

        if (fs.existsSync(game)) {
          if (fs.existsSync(path.join(game, 'config'))) {
            fse.removeSync(path.join(game, 'config'))
          }

          if (fs.existsSync(path.join(game, 'mods'))) {
            fse.removeSync(path.join(game, 'mods'))
          }
        }

        fse.mkdirsSync(game)

        $('#dialog #content_progress').html('Downloading pack..\
          <p id="fprog"></p>\
          <div class="progress"><div class="progress-bar" id="progbar_file"></div></div>')

        curse.hitFile(downloadUrl, tmpdir, workname + '.zip', (err, fname) => {
          if (err) return cb(err)
          $('#dialog #content_progress').html('Extracting pack..')
          let fpath = path.join(tmpdir, fname)
          extractZip(fpath, {dir: game}, (er) => {
            if (er) return cb(er)
            fse.removeSync(fpath)
            cb(null, packMeta, game)
          })
        }, (fname, progress, mb, mbtotal) => {
          $('.dialog #fprog').text('Downloaded ' + progress + '% - ' + mb + ' MB out of ' + mbtotal + ' MB')
          $('.dialog #progbar_file').css('width', progress + '%')
        })
      },
      function (packMeta, game, cb) {
        if (skipping) return cb(null, current.packMeta, current.game, null)
        let packjar = path.join(game, 'bin', 'modpack.jar')

        if (!fs.existsSync(packjar)) {
          fse.removeSync(game)
          return cb(new Error('Unrecognized packing format'))
        }

        let tmpextr = path.join(tmpdir, 'forge-extract-legacy')
        fse.mkdirsSync(tmpextr)

        $('#dialog #content_progress').html('Extracting modpack.jar')
        return extractZip(packjar, {dir: tmpextr}, (e) => {
          if (e) return cb(new Error('Invalid jar file.'))
          cb(null, packMeta, game, tmpextr)
        })
      },
      function (packMeta, game, tmpextr, cb) {
        if (skipping) return cb(null, current.packMeta, current.game, current.forge)
        $('#dialog #content_progress').html('Determining Forge version')
        let metaFile = path.join(tmpextr, 'version.json')

        try {
          metaFile = fse.readJsonSync(metaFile)
        } catch (e) {
          fse.removeSync(game)
          fse.removeSync(tmpextr)
          return cb(new Error('Invalid or missing version.json: This modpack is not supported, as it might be using legacy mod loaders.'))
        }

        let forgever = metaFile.id
        let profileVersion = metaFile.id
        let mcver = metaFile.jar || packMeta.minecraft

        // Sanitize forge version for downloading
        if (forgever.indexOf(mcver + '-') === 0) {
          forgever = forgever.substring((mcver + '-').length)
        }

        if (forgever.indexOf('Forge') === 0) {
          forgever = forgever.substring(5).replace('-' + mcver, '')
        }

        if (forgever.indexOf('forge' + mcver) === 0) {
          forgever = forgever.substring(5 + mcver.length + 1)
        }

        fse.removeSync(tmpextr)

        $('#dialog #content_progress').html('Requesting forge installation')
        if (!fs.existsSync(path.join(versions, profileVersion))) {
          queue[0].active = false
          queue[0].game = game
          queue[0].packMeta = packMeta
          queue[0].forge = profileVersion
          queue.unshift({
            type: 'forge',
            version: mcver,
            forgever: forgever,
            profile: false
          })
          queuePump()
          return
        }
        cb(null, packMeta, game, profileVersion)
      },
      function (packMeta, game, forge, cb) {
        $('#dialog #content_progress').html('Creating profile')

        let mpfind = null
        for (let i in configuration.modpacks) {
          let mpi = configuration.modpacks[i]
          if (mpi.name === packMeta.name) {
            mpfind = i
          }
        }

        // Modpack data profile
        let packdata = {
          id: uuid(),
          name: packMeta.name,
          version: forge,
          mcversion: packMeta.minecraft,
          game: game,
          meta: {
            name: packMeta.displayName || packMeta.name,
            version: packMeta.version,
            author: packMeta.user,
            url: url,
            viewUrl: packMeta.platformUrl,
            discord: packMeta.discordServerId || null,
            images: {
              icon: packMeta.icon || null,
              logo: packMeta.logo || null,
              background: packMeta.background || null
            }
          },
          source: 'technic',
          added: new Date()
        }

        if (mpfind != null) {
          configuration.modpacks[mpfind] = packdata
        } else {
          configuration.modpacks.push(packdata)
        }

        dataSave()
        refreshHTML()
        cb(null)
      },
      function (cb) {
        dialog.pop('Technic Platform Modpack', '<span id="content_progress">Done!</span>')
        dialog.setClosePossible(true)
        queue.splice(0, 1)
        queuePump()
      }
    ], (err) => {
      queueProgressError(err)
    })
  }
}

function getListVersions (cb, snapshots = false) {
  let filtered = []
  $.ajax({
    type: 'GET',
    url: 'https://launchermeta.mojang.com/mc/game/version_manifest.json',
    dataType: 'json',
    success: function (data) {
      for (let i in data.versions) {
        let ver = data.versions[i]

        if (!snapshots && ver.type === 'snapshot') {
          continue
        }

        if (ver.type !== 'release' && ver.type !== 'snapshot') {
          continue
        }

        filtered.push(ver)
      }

      cb(filtered)
    }
  })
}

function addDialog () {
  let html = $('#versionform').get(0).innerHTML
  dialog.pop('Add a version', html)

  for (let i in versionsList) {
    $('.dialog #versionsel').append('<option value="' + i + '">' + versionsList[i].id + '</option>')
  }

  $('.dialog #version_add').submit(function(e) {
    e.preventDefault()

    let name = $('.dialog #name').val()
    let version = $('.dialog #versionsel').val()

    let meta = versionsList[version]

    if (!meta) return
    if (!name) name = 'Minecraft ' + meta.id
    meta.name = name
    meta.class = meta.type
    meta.type = 'version'

    queue.push(meta)

    queuePump()
  })
}

function installModpack () {
  let html = $('#modpackform').get(0).innerHTML
  dialog.pop('Install a modpack', html)

  $('.dialog #version_add').submit(function(e) {
    e.preventDefault()

    let url = $('.dialog #url').val()

    queue.push({
      type: 'modpack',
      url: url
    })

    queuePump()
  })
}

function createModpack () {
  let html = $('#custommodpackform').get(0).innerHTML
  dialog.pop('Create a modpack', html)

  for (let i in versionsList) {
    $('.dialog #versionsel').append('<option value="' + i + '">' + versionsList[i].id + '</option>')
  }

  $('.dialog #version_add').submit(function(e) {
    e.preventDefault()

    let name = $('.dialog #name').val()
    let ver = $('.dialog #versionsel').val()
    let forgever = $('.dialog #forgever').val()
    let mcver = versionsList[ver].id

    queue.push({
      type: 'modpack',
      name: name,
      mcversion: mcver,
      forge: forgever
    })

    queuePump()
  })
}

function manageMods (mpid) {
  let html = $('#modmanager').get(0).innerHTML
  let modpack = getModpackById(mpid)
  dialog.pop('Manage Mods', html)

  let game = modpack.game
  let mods = path.join(game, 'mods')
  if (!fs.existsSync(mods)) {
    fs.mkdirSync(mods)
  }

  let files = fs.readdirSync(mods)
  let enabled = []
  let disabled = []

  for (let i in files) {
    let file = files[i]
    let fp = path.join(mods, file)
    if (fs.statSync(path.join(mods, file)).isDirectory()) continue
    if (file.indexOf('.jar') === -1) continue
    if (file.indexOf('.disabled') != -1) {
      disabled.push(file)
    } else {
      enabled.push(file)
    }
  }

  for (let i in enabled) {
    let fn = enabled[i]
    $('.dialog #enabled_mods').append('<option value="' + i + '">' + fn + '</option>')
  }

  for (let i in disabled) {
    let fn = disabled[i]
    $('.dialog #disabled_mods').append('<option value="' + i + '">' + fn + '</option>')
  }

  $('.dialog #disable').click(function () {
    let selected = $('.dialog #enabled_mods').val()
    if (selected != null) {
      let fn = enabled[parseInt(selected)]
      if (!fn) return
      let disabledPath = path.join(mods, fn + '.disabled')

      if (fs.existsSync(disabledPath)) {
        fse.removeSync(disabledPath)
      }

      fs.renameSync(path.join(mods, fn), disabledPath)
      manageMods(mpid)
    }
  })

  $('.dialog #delete').click(function () {
    let selected = $('.dialog #enabled_mods').val()
    if (selected != null) {
      let fn = enabled[parseInt(selected)]
      if (!fn) return
      let modPath = path.join(mods, fn)

      if (fs.existsSync(modPath)) {
        fse.removeSync(modPath)
      }

      manageMods(mpid)
    }
  })

  $('.dialog #enabled_mods').dblclick(function(e) {
    e.preventDefault()
    $('.dialog #disable').click()
  })

  $('.dialog #disabled_mods').dblclick(function(e) {
    e.preventDefault()
    $('.dialog #enable').click()
  })

  $('.dialog #enable').click(function () {
    let selected = $('.dialog #disabled_mods').val()
    if (selected != null) {
      let fn = disabled[parseInt(selected)]
      if (!fn) return

      let enabledPath = path.join(mods, fn.replace('.disabled', ''))
      let fnp = path.join(mods, fn)

      if (fs.existsSync(enabledPath)) {
        fse.removeSync(fnp)
      } else {
        fs.renameSync(fnp, enabledPath)
      }

      manageMods(mpid)
    }
  })

  $('.dialog #addmod').submit(function (e) {
    e.preventDefault()
    let modurl = $('.dialog #modurl').val()

    let url = modurl
    async.waterfall([
      function (cb) {
        let regex = /mods\.curse\.com\/mc-mods\/minecraft\/([\w\d-_]+)\/?(\d+)?/i
        let matchd = url.match(regex)
        if (matchd) {
          return cb(null, matchd[1], matchd[2], false)
        } else if (url.indexOf('curseforge.com/projects/') !== -1) {
          let filematching = /curseforge\.com\/projects\/([\w\d-_]+)(\/files\/(\d+))?/i
          let ma = url.match(filematching)
          if (ma != null) {
            if (ma[3]) {
              return cb(null, url + (url.indexOf('/download') === -1 ? '/download' : ''), null, true)
            }
            return cb(null, ma[1], ma[3], false)
          }
        } else {
          if (url.indexOf('.jar') === -1) return cb(new Error('Not a jar.'))
          return cb(null, url, null, true)
        }
        cb(new Error('Invalid file'))
      },
      function (project, file, skip, cb) {
        if (skip) return cb(null, project)
        $.ajax({
          type: 'GET',
          dataType: 'json',
          url: 'https://widget.mcf.li/mc-mods/minecraft/' + project + '.json',
          success: (data) => {
            let projectPath = 'https:' + data.project_url
            if (!data.versions[modpack.mcversion]) return cb(new Error('No mod for this version'))
            let gameversionfiles = data.versions[modpack.mcversion]
            let found

            if (file) {
              for (let i in gameversionfiles) {
                let gcf = gameversionfiles[i]
                if (gcf.id.toString() === file) {
                  found = gcf.id.toString()
                }
              }
            }

            if (!found) {
              found = gameversionfiles[0].id.toString()
            }

            let url = projectPath + 'files/' + found + '/download'

            cb(null, url)
          }
        }).fail(() => {
          cb(new Error('API Error'))
        })
      },
      function (url, cb) {
        $('.dialog .progress').show()
        curse.hitFile(url, mods, 'download', (err, fname) => {
          if (err) return cb(err)

          $('#modurl').css('background-color', '')
          manageMods(mpid)
        }, (fName, percent, mb, mbtotal) => {
          $('.dialog #progbar_file').css('width', percent + '%')
        })
      }
    ], (e) => {
      console.error(e)
      $('#modurl').css('background-color', '#ff9e9e')
    })
  })
}
