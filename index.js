const remoteMain = require('@electron/remote/main')
remoteMain.initialize()

// Requirements
const { app, BrowserWindow, ipcMain, Menu, shell, dialog } = require('electron')
const AdmZip                            = require('adm-zip')
const autoUpdater                       = require('electron-updater').autoUpdater
const ejse                              = require('ejs-electron')
const fs                                = require('fs')
const isDev                             = require('./app/assets/js/isdev')
const path                              = require('path')
const semver                            = require('semver')
const { pathToFileURL }                 = require('url')
const { AZURE_CLIENT_ID, MSFT_OPCODE, MSFT_REPLY_TYPE, MSFT_ERROR, SHELL_OPCODE } = require('./app/assets/js/ipcconstants')
const LangLoader                        = require('./app/assets/js/langloader')

// На части Windows-конфигураций GPU-композитинг Electron не перерисовывает окно
// после смены экрана — оно «залипает» на кадре «Загрузка…», хотя приложение уже
// на главном экране. Программная отрисовка убирает это залипание.
app.disableHardwareAcceleration()

// Setup Lang
LangLoader.setupLanguage()

// Setup auto updater.
function initAutoUpdater(event, data) {

    if(data){
        autoUpdater.allowPrerelease = true
    } else {
        // Defaults to true if application version contains prerelease components (e.g. 0.12.1-alpha.1)
        // autoUpdater.allowPrerelease = true
    }
    
    if(isDev){
        autoUpdater.autoInstallOnAppQuit = false
        autoUpdater.updateConfigPath = path.join(__dirname, 'dev-app-update.yml')
    }
    if(process.platform === 'darwin'){
        autoUpdater.autoDownload = false
    }
    autoUpdater.on('update-available', (info) => {
        event.sender.send('autoUpdateNotification', 'update-available', info)
    })
    autoUpdater.on('update-downloaded', (info) => {
        event.sender.send('autoUpdateNotification', 'update-downloaded', info)
    })
    autoUpdater.on('update-not-available', (info) => {
        event.sender.send('autoUpdateNotification', 'update-not-available', info)
    })
    autoUpdater.on('checking-for-update', () => {
        event.sender.send('autoUpdateNotification', 'checking-for-update')
    })
    autoUpdater.on('error', (err) => {
        event.sender.send('autoUpdateNotification', 'realerror', err)
    }) 
}

// Open channel to listen for update actions.
ipcMain.on('autoUpdateAction', (event, arg, data) => {
    switch(arg){
        case 'initAutoUpdater':
            console.log('Initializing auto updater.')
            initAutoUpdater(event, data)
            event.sender.send('autoUpdateNotification', 'ready')
            break
        case 'checkForUpdate':
            autoUpdater.checkForUpdates()
                .catch(err => {
                    event.sender.send('autoUpdateNotification', 'realerror', err)
                })
            break
        case 'allowPrereleaseChange':
            if(!data){
                const preRelComp = semver.prerelease(app.getVersion())
                if(preRelComp != null && preRelComp.length > 0){
                    autoUpdater.allowPrerelease = true
                } else {
                    autoUpdater.allowPrerelease = data
                }
            } else {
                autoUpdater.allowPrerelease = data
            }
            break
        case 'installUpdateNow':
            autoUpdater.quitAndInstall()
            break
        default:
            console.log('Unknown argument', arg)
            break
    }
})
// Redirect distribution index event from preloader to renderer.
ipcMain.on('distributionIndexDone', (event, res) => {
    event.sender.send('distributionIndexDone', res)
})

// Управление окном (кастомный верхний бар).
ipcMain.on('win-minimize', () => { if(win) win.minimize() })
ipcMain.on('win-maximize', () => { if(win){ win.isMaximized() ? win.unmaximize() : win.maximize() } })
ipcMain.on('win-close', () => { if(win) win.close() })

// Экспорт текущего скачанного инстанса в zip формата MultiMC/Prism (mmc-pack.json + instance.cfg + .minecraft/).
// Ванильный клиент и Forge НЕ упаковываются — Prism скачает их сам по mmc-pack.json, экспортируется
// только специфика сборки (моды/конфиги/kubejs/ресурспаки и т.п.), как при штатном экспорте из MultiMC.
const EXPORT_EXCLUDE_DIRS = new Set(['logs', 'crash-reports', 'cache', '.cache', '.mixin.out', 'lightspeed-cache', 'saves'])
const EXPORT_EXCLUDE_FILES = new Set(['servers.dat_old'])

// Не можем require('./app/assets/js/configmanager') из main-процесса — этот модуль
// делает require('@electron/remote') на верхнем уровне (валидно только в renderer),
// что валит весь app при старте. Читаем dataDirectory из config.json напрямую.
function getDataDirectory(){
    const sysRoot = process.env.APPDATA || (process.platform === 'darwin' ? process.env.HOME + '/Library/Application Support' : process.env.HOME)
    const defaultDataPath = path.join(sysRoot, '.esketitlauncher')
    try {
        const configPath = path.join(app.getPath('userData'), 'config.json')
        const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
        return (cfg.settings && cfg.settings.launcher && cfg.settings.launcher.dataDirectory) || defaultDataPath
    } catch(e){
        return defaultDataPath
    }
}

ipcMain.handle('export-instance', async (event, { serverId, minecraftVersion, forgeVersion, instanceName }) => {
    try {
        const instanceDir = path.join(getDataDirectory(), 'instances', serverId)
        if(!fs.existsSync(instanceDir)) {
            return { success: false, error: 'Инстанс ещё не скачан. Сначала запустите игру хотя бы раз.' }
        }

        const { canceled, filePath } = await dialog.showSaveDialog(win, {
            title: 'Сохранить инстанс для Prism/MultiMC',
            defaultPath: path.join(app.getPath('desktop'), `${instanceName || 'EsketitCraft'}-instance.zip`),
            filters: [{ name: 'Zip Archive', extensions: ['zip'] }]
        })
        if(canceled || !filePath){
            return { success: false, canceled: true }
        }

        const rootInZip = (instanceName || 'EsketitCraft').replace(/[\\/:*?"<>|]/g, '_')

        const allFiles = []
        const walk = (dir, rel) => {
            for(const name of fs.readdirSync(dir)){
                if(!rel && (EXPORT_EXCLUDE_DIRS.has(name) || EXPORT_EXCLUDE_FILES.has(name))) continue
                const full = path.join(dir, name)
                const relPath = rel ? path.join(rel, name) : name
                const st = fs.statSync(full)
                if(st.isDirectory()) walk(full, relPath)
                else allFiles.push({ full, relPath })
            }
        }
        walk(instanceDir, '')

        const zip = new AdmZip()
        let done = 0
        for(const f of allFiles){
            const zipDir = `${rootInZip}/.minecraft/${path.dirname(f.relPath).replace(/\\/g, '/')}`
                .replace(/\/\.$/, '')
            zip.addLocalFile(f.full, zipDir, path.basename(f.relPath))
            done++
            if(done % 25 === 0 || done === allFiles.length){
                event.sender.send('export-instance-progress', { done, total: allFiles.length })
                await new Promise(r => setImmediate(r))
            }
        }

        const mmcPack = {
            formatVersion: 1,
            components: [
                { important: true, uid: 'net.minecraft', version: minecraftVersion || '1.20.1' },
                { uid: 'net.minecraftforge', version: forgeVersion || '47.4.20' }
            ]
        }
        zip.addFile(`${rootInZip}/mmc-pack.json`, Buffer.from(JSON.stringify(mmcPack, null, 4)))
        const instanceCfg = '[General]\nConfigVersion=1.2\nInstanceType=OneSix\n'
            + `name=${instanceName || 'EsketitCraft'}\niconKey=default\n`
        zip.addFile(`${rootInZip}/instance.cfg`, Buffer.from(instanceCfg))

        zip.writeZip(filePath)

        return { success: true, path: filePath, fileCount: allFiles.length }
    } catch(err){
        console.error('export-instance failed:', err)
        return { success: false, error: err.message }
    }
})


// Handle trash item.
ipcMain.handle(SHELL_OPCODE.TRASH_ITEM, async (event, ...args) => {
    try {
        await shell.trashItem(args[0])
        return {
            result: true
        }
    } catch(error) {
        return {
            result: false,
            error: error
        }
    }
})

// Disable hardware acceleration.
// https://electronjs.org/docs/tutorial/offscreen-rendering
app.disableHardwareAcceleration()


const REDIRECT_URI_PREFIX = 'https://login.microsoftonline.com/common/oauth2/nativeclient?'

// Microsoft Auth Login
let msftAuthWindow
let msftAuthSuccess
let msftAuthViewSuccess
let msftAuthViewOnClose
ipcMain.on(MSFT_OPCODE.OPEN_LOGIN, (ipcEvent, ...arguments_) => {
    if (msftAuthWindow) {
        ipcEvent.reply(MSFT_OPCODE.REPLY_LOGIN, MSFT_REPLY_TYPE.ERROR, MSFT_ERROR.ALREADY_OPEN, msftAuthViewOnClose)
        return
    }
    msftAuthSuccess = false
    msftAuthViewSuccess = arguments_[0]
    msftAuthViewOnClose = arguments_[1]
    msftAuthWindow = new BrowserWindow({
        title: LangLoader.queryJS('index.microsoftLoginTitle'),
        backgroundColor: '#222222',
        width: 520,
        height: 600,
        frame: true,
        icon: getPlatformIcon('SealCircle')
    })

    msftAuthWindow.on('closed', () => {
        msftAuthWindow = undefined
    })

    msftAuthWindow.on('close', () => {
        if(!msftAuthSuccess) {
            ipcEvent.reply(MSFT_OPCODE.REPLY_LOGIN, MSFT_REPLY_TYPE.ERROR, MSFT_ERROR.NOT_FINISHED, msftAuthViewOnClose)
        }
    })

    msftAuthWindow.webContents.on('did-navigate', (_, uri) => {
        if (uri.startsWith(REDIRECT_URI_PREFIX)) {
            let queryMap = {}
            
            new URL(uri).searchParams.forEach((v, k) => {
                queryMap[k] = v;
            });

            ipcEvent.reply(MSFT_OPCODE.REPLY_LOGIN, MSFT_REPLY_TYPE.SUCCESS, queryMap, msftAuthViewSuccess)

            msftAuthSuccess = true
            msftAuthWindow.close()
            msftAuthWindow = null
        }
    })

    msftAuthWindow.removeMenu()
    msftAuthWindow.loadURL(`https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize?prompt=select_account&client_id=${AZURE_CLIENT_ID}&response_type=code&scope=XboxLive.signin%20offline_access&redirect_uri=https://login.microsoftonline.com/common/oauth2/nativeclient`)
})

// Microsoft Auth Logout
let msftLogoutWindow
let msftLogoutSuccess
let msftLogoutSuccessSent
ipcMain.on(MSFT_OPCODE.OPEN_LOGOUT, (ipcEvent, uuid, isLastAccount) => {
    if (msftLogoutWindow) {
        ipcEvent.reply(MSFT_OPCODE.REPLY_LOGOUT, MSFT_REPLY_TYPE.ERROR, MSFT_ERROR.ALREADY_OPEN)
        return
    }

    msftLogoutSuccess = false
    msftLogoutSuccessSent = false
    msftLogoutWindow = new BrowserWindow({
        title: LangLoader.queryJS('index.microsoftLogoutTitle'),
        backgroundColor: '#222222',
        width: 520,
        height: 600,
        frame: true,
        icon: getPlatformIcon('SealCircle')
    })

    msftLogoutWindow.on('closed', () => {
        msftLogoutWindow = undefined
    })

    msftLogoutWindow.on('close', () => {
        if(!msftLogoutSuccess) {
            ipcEvent.reply(MSFT_OPCODE.REPLY_LOGOUT, MSFT_REPLY_TYPE.ERROR, MSFT_ERROR.NOT_FINISHED)
        } else if(!msftLogoutSuccessSent) {
            msftLogoutSuccessSent = true
            ipcEvent.reply(MSFT_OPCODE.REPLY_LOGOUT, MSFT_REPLY_TYPE.SUCCESS, uuid, isLastAccount)
        }
    })
    
    msftLogoutWindow.webContents.on('did-navigate', (_, uri) => {
        if(uri.startsWith('https://login.microsoftonline.com/common/oauth2/v2.0/logoutsession')) {
            msftLogoutSuccess = true
            setTimeout(() => {
                if(!msftLogoutSuccessSent) {
                    msftLogoutSuccessSent = true
                    ipcEvent.reply(MSFT_OPCODE.REPLY_LOGOUT, MSFT_REPLY_TYPE.SUCCESS, uuid, isLastAccount)
                }

                if(msftLogoutWindow) {
                    msftLogoutWindow.close()
                    msftLogoutWindow = null
                }
            }, 5000)
        }
    })
    
    msftLogoutWindow.removeMenu()
    msftLogoutWindow.loadURL('https://login.microsoftonline.com/common/oauth2/v2.0/logout')
})

// Keep a global reference of the window object, if you don't, the window will
// be closed automatically when the JavaScript object is garbage collected.
let win

function createWindow() {

    win = new BrowserWindow({
        width: 980,
        height: 552,
        icon: getPlatformIcon('esketit_e'),
        frame: false,
        webPreferences: {
            preload: path.join(__dirname, 'app', 'assets', 'js', 'preloader.js'),
            nodeIntegration: true,
            contextIsolation: false,
            backgroundThrottling: false // не троттлить отрисовку — иначе окно залипает на кадре
        },
        backgroundColor: '#171614'
    })
    remoteMain.enable(win.webContents)

    const data = {
        bkid: Math.floor((Math.random() * fs.readdirSync(path.join(__dirname, 'app', 'assets', 'images', 'backgrounds')).length)),
        lang: (str, placeHolders) => LangLoader.queryEJS(str, placeHolders)
    }
    Object.entries(data).forEach(([key, val]) => ejse.data(key, val))

    win.loadURL(pathToFileURL(path.join(__dirname, 'app', 'esketit.html')).toString())

    win.removeMenu()

    win.resizable = true

    win.on('closed', () => {
        win = null
    })
}

function createMenu() {
    
    if(process.platform === 'darwin') {

        // Extend default included application menu to continue support for quit keyboard shortcut
        let applicationSubMenu = {
            label: 'Application',
            submenu: [{
                label: 'About Application',
                selector: 'orderFrontStandardAboutPanel:'
            }, {
                type: 'separator'
            }, {
                label: 'Quit',
                accelerator: 'Command+Q',
                click: () => {
                    app.quit()
                }
            }]
        }

        // New edit menu adds support for text-editing keyboard shortcuts
        let editSubMenu = {
            label: 'Edit',
            submenu: [{
                label: 'Undo',
                accelerator: 'CmdOrCtrl+Z',
                selector: 'undo:'
            }, {
                label: 'Redo',
                accelerator: 'Shift+CmdOrCtrl+Z',
                selector: 'redo:'
            }, {
                type: 'separator'
            }, {
                label: 'Cut',
                accelerator: 'CmdOrCtrl+X',
                selector: 'cut:'
            }, {
                label: 'Copy',
                accelerator: 'CmdOrCtrl+C',
                selector: 'copy:'
            }, {
                label: 'Paste',
                accelerator: 'CmdOrCtrl+V',
                selector: 'paste:'
            }, {
                label: 'Select All',
                accelerator: 'CmdOrCtrl+A',
                selector: 'selectAll:'
            }]
        }

        // Bundle submenus into a single template and build a menu object with it
        let menuTemplate = [applicationSubMenu, editSubMenu]
        let menuObject = Menu.buildFromTemplate(menuTemplate)

        // Assign it to the application
        Menu.setApplicationMenu(menuObject)

    }

}

function getPlatformIcon(filename){
    let ext
    switch(process.platform) {
        case 'win32':
            ext = 'ico'
            break
        case 'darwin':
        case 'linux':
        default:
            ext = 'png'
            break
    }

    return path.join(__dirname, 'app', 'assets', 'images', `${filename}.${ext}`)
}

// Разрешаем только ОДИН экземпляр лаунчера. Иначе повторный запуск (двойной клик
// по ярлыку, перезапуск после автообновления) плодит процессы, конфликтующие за
// кэш в userData → окно виснет на «Загрузка…».
const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
    app.quit()
} else {
    app.on('second-instance', () => {
        // Пользователь запустил лаунчер ещё раз. Показываем/фокусируем окно ТОЛЬКО если
        // оно уже видимо (прошло экран загрузки). Если ещё скрыто (идёт загрузка) —
        // НЕ трогаем: иначе покажем залипший кадр «Загрузка…». Оно само покажется по ui-ready.
        if (win && win.isVisible()) {
            if (win.isMinimized()) win.restore()
            win.focus()
        }
    })

    app.on('ready', createWindow)
    app.on('ready', createMenu)
}

app.on('window-all-closed', () => {
    // On macOS it is common for applications and their menu bar
    // to stay active until the user quits explicitly with Cmd + Q
    if (process.platform !== 'darwin') {
        app.quit()
    }
})

app.on('activate', () => {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (win === null) {
        createWindow()
    }
})
