/**
 * ESKETIT Launcher — контроллер собственного UI поверх helios-core.
 * Пути require резолвятся относительно esketit.html (папка app/).
 */
const { ipcRenderer, shell } = require('electron')
const remote        = require('@electron/remote')
const ConfigManager = require('./assets/js/configmanager')
const AuthManager   = require('./assets/js/authmanager')
const { DistroAPI } = require('./assets/js/distromanager')
const { MSFT_OPCODE, MSFT_REPLY_TYPE } = require('./assets/js/ipcconstants')
const ProcessBuilder = require('./assets/js/processbuilder')
const { FullRepair, DistributionIndexProcessor, MojangIndexProcessor, downloadFile } = require('helios-core/dl')
const { validateSelectedJvm, ensureJavaDirIsRoot, javaExecFromRoot, discoverBestJvmInstallation, latestOpenJDK, extractJdk } = require('helios-core/java')

ConfigManager.load()
DistroAPI.commonDir = ConfigManager.getCommonDirectory()
DistroAPI.instanceDir = ConfigManager.getInstanceDirectory()

const $ = (id) => document.getElementById(id)
const VIEWS = ['loadingView', 'loginView', 'offlineView', 'landingView', 'settingsView', 'modsView']
function show(id){
    VIEWS.forEach(v => $(v).classList.toggle('active', v === id))
    // Уходим с экрана загрузки — просим главный процесс форсировать перерисовку окна
    // (на части ПК окно залипает на кадре «Загрузка…», хотя DOM уже переключился).
    if(id !== 'loadingView'){
        requestAnimationFrame(() => { try { ipcRenderer.send('force-repaint') } catch(e){} })
    }
}

let distribution = null
let server = null

// ─── Инициализация ──────────────────────────────────────────────────────────
async function init(){
    try {
        distribution = await DistroAPI.getDistribution()
        server = distribution.getServerById(ConfigManager.getSelectedServer()) || distribution.getMainServer()
        if(server){ ConfigManager.setSelectedServer(server.rawServer.id); ConfigManager.save() }
    } catch(err){
        console.error('Не удалось загрузить дистрибутив:', err)
    }
    const accounts = ConfigManager.getAuthAccounts()
    const sel = ConfigManager.getSelectedAccount()
    if(sel && Object.keys(accounts).length > 0){
        enterLanding()
    } else {
        show('loginView')
    }
    initUpdates()
}

// ─── Автообновление лаунчера (electron-updater + GitHub Releases) ──────────────
// Логика в главном процессе (index.js) уже разведена по IPC autoUpdateAction /
// autoUpdateNotification. Здесь — только запуск проверки и вывод плашки.
function initUpdates(){
    ipcRenderer.on('autoUpdateNotification', (event, arg, info) => {
        switch(arg){
            case 'ready':
                // Разрешаем pre-release из настроек, затем проверяем обновления.
                ipcRenderer.send('autoUpdateAction', 'allowPrereleaseChange', ConfigManager.getAllowPrerelease())
                ipcRenderer.send('autoUpdateAction', 'checkForUpdate')
                break
            case 'update-available':
                showUpdateBar(`Доступно обновление v${info.version} — скачивается…`, false)
                break
            case 'update-downloaded':
                showUpdateBar(`Обновление v${info.version} готово`, true)
                break
            case 'update-not-available':
            case 'checking-for-update':
            case 'realerror':
            case 'error':
                break // тихо: нет обновлений / оффлайн / dev-режим без релизов
        }
    })
    ipcRenderer.send('autoUpdateAction', 'initAutoUpdater')
}

function showUpdateBar(text, canInstall){
    const bar = $('updateBar')
    if(!bar) return
    $('updateText').textContent = text
    $('btnUpdateNow').style.display = canInstall ? '' : 'none'
    bar.style.display = 'flex'
}

// ─── Главный экран ──────────────────────────────────────────────────────────
function enterLanding(){
    populateLanding()
    show('landingView')
    refreshStatus()
    loadNews()
}

// ─── Новости («Что нового») — динамически из news.json ─────────────────────────
// Меняешь этот JSON на хостинге — новости в лаунчере обновляются (пересборка не нужна).
// Для боевого сервера замени URL на свой, напр. https://твой-домен/news.json
const NEWS_URL = 'https://stuffy-man.github.io/esketit-dist/news.json'
async function loadNews(){
    const panel = $('newsPanel'), list = $('newsList')
    try {
        const got = require('got')
        const data = (await got(NEWS_URL, { responseType: 'json', timeout: { request: 5000 } })).body
        const items = Array.isArray(data) ? data : (data.items || [])
        if(!items.length){ panel.style.display = 'none'; return }
        list.innerHTML = ''
        items.slice(0, 8).forEach(it => {
            const row = document.createElement('div'); row.className = 'news-item'
            const d = document.createElement('span'); d.className = 'ni-date'; d.textContent = it.date || ''
            const t = document.createElement('span'); t.className = 'ni-txt'; t.innerHTML = it.text || ''
            row.appendChild(d); row.appendChild(t); list.appendChild(row)
        })
        panel.style.display = ''
    } catch(err){
        panel.style.display = 'none' // нет файла/сети — блок скрыт
    }
}

function countMods(srv){
    try {
        let n = 0
        const walk = (mods) => mods.forEach(m => {
            const t = m.rawModule.type
            if(t === 'ForgeMod' || t === 'FabricMod' || t === 'LiteMod') n++
            if(m.subModules && m.subModules.length) walk(m.subModules)
        })
        walk(srv.modules)
        return n
    } catch(e){ return 0 }
}

function populateLanding(){
    const acc = ConfigManager.getSelectedAccount()
    if(acc){
        $('playerName').textContent = acc.displayName
        $('playerRole').textContent = acc.type === 'microsoft' ? 'Лицензия · Microsoft'
            : acc.type === 'offline' ? 'Офлайн-аккаунт' : acc.type
        if(acc.uuid){
            const face = $('playerFace')
            face.style.backgroundImage = `url('https://mc-heads.net/avatar/${acc.uuid}/44')`
            face.textContent = ''
        }
    }
    if(server){
        const raw = server.rawServer
        $('serverDesc').textContent = raw.description || ('Minecraft ' + raw.minecraftVersion)
        const badges = $('badges'); badges.innerHTML = ''
        const items = ['MC ' + raw.minecraftVersion, 'Forge']
        const mc = countMods(server); if(mc > 0) items.push(mc + ' модов')
        items.forEach(t => { const s = document.createElement('span'); s.className = 'badge'; s.textContent = t; badges.appendChild(s) })
        $('playSub').textContent = 'ОЗУ: ' + ConfigManager.getMaxRAM(raw.id)
    }
}

async function refreshStatus(){
    $('statusText').textContent = 'СЕРВЕР'
    $('statusDot').classList.add('off')
    $('playerCount').textContent = '· оффлайн'
    if(!server) return
    try {
        const { getServerStatus } = require('helios-core/mojang')
        const st = await getServerStatus(47, server.hostname, server.port)
        $('statusDot').classList.remove('off')
        $('statusText').textContent = 'ОНЛАЙН'
        $('playerCount').textContent = st && st.players ? `· ${st.players.online} / ${st.players.max} игроков` : ''
    } catch(err){
        // сервер недоступен — оставляем оффлайн
    }
}

// ─── Авторизация ────────────────────────────────────────────────────────────
$('btnOffline').onclick = () => { $('offlineErr').textContent = ''; $('offlineNick').value = ''; show('offlineView'); $('offlineNick').focus() }
$('btnOfflineBack').onclick = () => show('loginView')

function doOffline(){
    const nick = $('offlineNick').value.trim()
    // Двухаргументный then: обработчик ошибок ловит ТОЛЬКО отказ добавления аккаунта,
    // а не возможные исключения enterLanding (иначе они маскируются под «неверный ник»).
    AuthManager.addOfflineAccount(nick).then(
        () => enterLanding(),
        err => { $('offlineErr').textContent = (err && err.desc) || 'Некорректный ник' }
    )
}
$('btnOfflineGo').onclick = doOffline
$('offlineNick').addEventListener('keydown', e => { if(e.key === 'Enter') doOffline() })

function showLoginError(err){
    const el = $('loginErr')
    if(!el) return
    let msg
    if(err && (err.title || err.desc)){
        msg = [err.title, err.desc].filter(Boolean).join(' — ')
    } else {
        // сырое исключение (напр. аккаунт без Minecraft, сеть) — общее пояснение
        msg = 'Не удалось войти через Microsoft. Убедись, что на этом аккаунте куплен Minecraft: Java Edition, и повтори попытку.'
    }
    el.innerHTML = msg
    el.style.display = ''
}

$('btnMicrosoft').onclick = () => {
    const le = $('loginErr'); if(le) le.style.display = 'none'
    $('loadingText').textContent = 'Ожидание входа Microsoft…'
    show('loadingView')
    ipcRenderer.send(MSFT_OPCODE.OPEN_LOGIN, 'landingView', 'loginView')
}
ipcRenderer.on(MSFT_OPCODE.REPLY_LOGIN, (event, type, data, view) => {
    if(type === MSFT_REPLY_TYPE.SUCCESS){
        const authCode = data.code
        $('loadingText').textContent = 'Входим…'
        AuthManager.addMicrosoftAccount(authCode).then(() => {
            enterLanding()
        }).catch(err => {
            console.error('Ошибка Microsoft-входа:', err)
            showLoginError(err)
            show('loginView')
        })
    } else {
        // отмена/ошибка входа
        show(view === 'landingView' && ConfigManager.getSelectedAccount() ? 'landingView' : 'loginView')
    }
})

// ─── Смена аккаунта ───────────────────────────────────────────────────────────
$('btnSwitch').onclick = () => show('loginView')

// ─── Управление окном (верхний бар) ───────────────────────────────────────────
$('winMin').onclick = () => ipcRenderer.send('win-minimize')
$('winMax').onclick = () => ipcRenderer.send('win-maximize')
$('winClose').onclick = () => ipcRenderer.send('win-close')
if($('btnUpdateNow')) $('btnUpdateNow').onclick = () => ipcRenderer.send('autoUpdateAction', 'installUpdateNow')

// ─── Настройки (полные) ─────────────────────────────────────────────────────
function ramToInt(v){ const m = String(v).match(/(\d+)\s*([GM])/i); if(!m) return parseInt(v) || 4; return m[2].toUpperCase() === 'M' ? Math.max(1, Math.round(parseInt(m[1]) / 1024)) : parseInt(m[1]) }
function setToggle(el, on){ el.classList.toggle('on', !!on) }

function openSettings(){
    const sid = server && server.rawServer.id
    const absMax = Math.max(8, ConfigManager.getAbsoluteMaxRAM())
    const rMax = $('ramMax'), rMin = $('ramMin')
    rMax.min = rMin.min = 2; rMax.max = rMin.max = absMax; rMax.step = rMin.step = 1
    if(sid){
        rMax.value = ramToInt(ConfigManager.getMaxRAM(sid))
        rMin.value = ramToInt(ConfigManager.getMinRAM(sid))
        $('javaExe').value = ConfigManager.getJavaExecutable(sid) || ''
        const opts = ConfigManager.getJVMOptions(sid)
        $('jvmArgs').value = Array.isArray(opts) ? opts.join(' ') : ''
    }
    $('ramMaxVal').textContent = rMax.value + ' ГБ'
    $('ramMinVal').textContent = rMin.value + ' ГБ'
    $('resW').value = ConfigManager.getGameWidth()
    $('resH').value = ConfigManager.getGameHeight()
    setToggle($('tgFull'), ConfigManager.getFullscreen())
    setToggle($('tgAuto'), ConfigManager.getAutoConnect())
    setToggle($('tgDetach'), ConfigManager.getLaunchDetached())
    setToggle($('tgPre'), ConfigManager.getAllowPrerelease())
    const dd = ConfigManager.getDataDirectory()
    $('dataDir').textContent = dd; $('dataDir').title = dd
    $('setServerInfo').textContent = server ? (server.rawServer.name + ' · ' + server.rawServer.minecraftVersion) : '—'
    show('settingsView')
}
$('btnSettings').onclick = openSettings
$('btnSettingsBack').onclick = () => { populateLanding(); show('landingView') }

$('ramMax').addEventListener('input', e => { $('ramMaxVal').textContent = e.target.value + ' ГБ'; if(server){ ConfigManager.setMaxRAM(server.rawServer.id, e.target.value + 'G'); ConfigManager.save() } })
$('ramMin').addEventListener('input', e => { $('ramMinVal').textContent = e.target.value + ' ГБ'; if(server){ ConfigManager.setMinRAM(server.rawServer.id, e.target.value + 'G'); ConfigManager.save() } })
$('javaExe').addEventListener('change', e => { if(server){ ConfigManager.setJavaExecutable(server.rawServer.id, e.target.value.trim()); ConfigManager.save() } })
$('jvmArgs').addEventListener('change', e => { if(server){ const t = e.target.value.trim(); ConfigManager.setJVMOptions(server.rawServer.id, t.length ? t.split(/\s+/) : []); ConfigManager.save() } })
$('resW').addEventListener('change', e => { ConfigManager.setGameWidth(parseInt(e.target.value) || 1280); ConfigManager.save() })
$('resH').addEventListener('change', e => { ConfigManager.setGameHeight(parseInt(e.target.value) || 720); ConfigManager.save() })
function bindToggle(id, setter){ $(id).onclick = () => { const nv = !$(id).classList.contains('on'); setToggle($(id), nv); setter(nv); ConfigManager.save() } }
bindToggle('tgFull', v => ConfigManager.setFullscreen(v))
bindToggle('tgAuto', v => ConfigManager.setAutoConnect(v))
bindToggle('tgDetach', v => ConfigManager.setLaunchDetached(v))
bindToggle('tgPre', v => ConfigManager.setAllowPrerelease(v))
$('btnOpenData').onclick = () => { try { shell.openPath(ConfigManager.getDataDirectory()) } catch(e){ console.error(e) } }

// ─── Прочее ────────────────────────────────────────────────────────────────────
$('btnFolder').onclick = () => {
    try { shell.openPath(ConfigManager.getInstanceDirectory()) } catch(e){ console.error(e) }
}
// ─── Экран модов ───────────────────────────────────────────────────────────
function collectMods(srv){
    const out = []
    if(!srv || !srv.modules) return out
    const TYPES = ['ForgeMod', 'FabricMod', 'LiteMod']
    const walk = mods => mods.forEach(m => {
        if(TYPES.includes(m.rawModule.type)){
            let ver = ''
            try { ver = m.getMavenComponents ? m.getMavenComponents().version : '' } catch(e){}
            let key = m.rawModule.id
            try { key = m.getVersionlessMavenIdentifier ? m.getVersionlessMavenIdentifier() : m.rawModule.id } catch(e){}
            const req = m.getRequired ? m.getRequired() : { value: true, def: true }
            out.push({ name: m.rawModule.name || m.rawModule.id, version: ver, required: req.value !== false, def: req.def !== false, key })
        }
        if(m.subModules && m.subModules.length) walk(m.subModules)
    })
    walk(srv.modules)
    return out
}
function saveModState(key, on){
    const sid = ConfigManager.getSelectedServer()
    const cfg = ConfigManager.getModConfiguration(sid) || { id: sid, mods: {} }
    if(!cfg.mods) cfg.mods = {}
    cfg.mods[key] = on
    ConfigManager.setModConfiguration(sid, cfg)
    ConfigManager.save()
}
function openMods(){
    const list = $('modsList'); list.innerHTML = ''
    // показываем только клиентские (опциональные) моды; обязательные геймплей/зависимости скрыты
    const mods = collectMods(server).filter(m => !m.required)
    if(!mods.length){
        list.innerHTML = '<div class="set-section"><div class="prole" style="line-height:1.6">Нет клиентских модов для настройки. Обязательные моды сборки скачиваются и включаются автоматически.</div></div>'
        show('modsView'); return
    }
    const cfg = ConfigManager.getModConfiguration(ConfigManager.getSelectedServer()) || { mods: {} }
    const mkSection = (title, arr, toggleable) => {
        if(!arr.length) return
        const sec = document.createElement('div'); sec.className = 'set-section'
        const h = document.createElement('h3'); h.textContent = `${title} · ${arr.length}`; sec.appendChild(h)
        arr.forEach(m => {
            const row = document.createElement('div'); row.className = 'set-row'
            const lab = document.createElement('div')
            lab.innerHTML = `<span>${m.name}</span>` + (m.version ? ` <span class="hint">${m.version}</span>` : '')
            row.appendChild(lab)
            if(toggleable){
                const t = document.createElement('button'); t.className = 'toggle'
                const on = (cfg.mods && (m.key in cfg.mods)) ? cfg.mods[m.key] : m.def
                if(on) t.classList.add('on')
                t.onclick = () => { const nv = !t.classList.contains('on'); t.classList.toggle('on', nv); saveModState(m.key, nv) }
                row.appendChild(t)
            } else {
                const b = document.createElement('span'); b.className = 'badge'; b.textContent = 'обязательный'; row.appendChild(b)
            }
            sec.appendChild(row)
        })
        list.appendChild(sec)
    }
    mkSection('Клиентские моды', mods, true)
    show('modsView')
}
$('btnMods').onclick = openMods
$('btnModsBack').onclick = () => show('landingView')

// ─── Кнопка ИГРАТЬ — реальный запуск (helios-core) ─────────────────────────────
let gameProc = null
let launching = false
const GAME_LAUNCH_REGEX = /^\[.+\]: (?:MinecraftForge .+ Initialized|ModLauncher .+ starting: .+|Loading Minecraft .+ with Fabric Loader .+)$/

function launchUI(on){ $('launchProgressWrap').style.display = on ? 'flex' : 'none'; $('btnPlay').disabled = on }
function setStatus(t){ $('launchStatus').textContent = t }
function setPct(p){ $('launchBarFill').style.width = Math.max(0, Math.min(100, p)) + '%' }
function setDlPct(p){ try { remote.getCurrentWindow().setProgressBar(p / 100) } catch(e){}; setPct(p) }
function launchFail(msg){ launching = false; launchUI(false); try{ remote.getCurrentWindow().setProgressBar(-1) }catch(e){}; $('playState').textContent = 'Ошибка запуска'; setStatus(msg); console.error('Launch failed:', msg) }

async function play(){
    if(launching) return
    const acc = ConfigManager.getSelectedAccount()
    if(!acc){ show('loginView'); return }
    if(!server){ launchFail('Сервер не загружен'); return }
    launching = true
    launchUI(true); setPct(0)
    $('playState').textContent = 'Подготовка…'
    try {
        const sid = ConfigManager.getSelectedServer()
        // Java: проверить/найти/скачать
        let jExe = ConfigManager.getJavaExecutable(sid)
        let jvmOk = false
        if(jExe){
            const d = await validateSelectedJvm(ensureJavaDirIsRoot(jExe), server.effectiveJavaOptions.supported)
            jvmOk = d != null
        }
        if(!jvmOk){
            setStatus('Поиск подходящей Java…')
            const jvm = await discoverBestJvmInstallation(ConfigManager.getDataDirectory(), server.effectiveJavaOptions.supported)
            if(jvm){
                jExe = javaExecFromRoot(jvm.path)
            } else {
                setStatus('Скачивание Java (один раз)…')
                jExe = await downloadJava(server.effectiveJavaOptions)
            }
            ConfigManager.setJavaExecutable(sid, jExe); ConfigManager.save()
        }
        await dlAsync()
    } catch(err){
        launchFail((err && err.message) || 'см. консоль')
    }
}

async function downloadJava(opts){
    const asset = await latestOpenJDK(opts.suggestedMajor, ConfigManager.getDataDirectory(), opts.distribution)
    if(!asset) throw new Error('Не найден пакет Java')
    await downloadFile(asset.url, asset.path, ({ transferred }) => setDlPct(Math.trunc((transferred / asset.size) * 100)))
    setDlPct(100)
    setStatus('Распаковка Java…')
    const exe = await extractJdk(asset.path)
    try { remote.getCurrentWindow().setProgressBar(-1) } catch(e){}
    return exe
}

async function dlAsync(){
    setStatus('Загрузка данных сервера…')
    let distro
    try { distro = await DistroAPI.refreshDistributionOrFallback() }
    catch(e){ return launchFail('Не удалось загрузить дистрибутив') }
    const serv = distro.getServerById(ConfigManager.getSelectedServer())

    const fr = new FullRepair(
        ConfigManager.getCommonDirectory(),
        ConfigManager.getInstanceDirectory(),
        ConfigManager.getLauncherDirectory(),
        ConfigManager.getSelectedServer(),
        DistroAPI.isDevMode()
    )
    fr.spawnReceiver()
    fr.childProcess.on('error', err => launchFail(err.message || 'ошибка модуля проверки'))
    fr.childProcess.on('close', code => { if(code !== 0) launchFail('модуль проверки завершился с кодом ' + code) })

    setStatus('Проверка файлов…'); setPct(0)
    let invalid = 0
    try { invalid = await fr.verifyFiles(p => setPct(p)); setPct(100) }
    catch(e){ return launchFail('ошибка проверки файлов') }

    if(invalid > 0){
        setStatus('Скачивание файлов…'); setPct(0)
        try { await fr.download(p => setDlPct(p)); setDlPct(100) }
        catch(e){ return launchFail('ошибка скачивания файлов') }
    }
    try { remote.getCurrentWindow().setProgressBar(-1) } catch(e){}
    fr.destroyReceiver()

    setStatus('Подготовка запуска…')
    const mip = new MojangIndexProcessor(ConfigManager.getCommonDirectory(), serv.rawServer.minecraftVersion)
    const dip = new DistributionIndexProcessor(ConfigManager.getCommonDirectory(), distro, serv.rawServer.id)
    const modLoaderData = await dip.loadModLoaderVersionJson(serv)
    const versionData = await mip.getVersionJson()

    const authUser = ConfigManager.getSelectedAccount()
    const pb = new ProcessBuilder(serv, versionData, modLoaderData, authUser, remote.app.getVersion())
    setStatus('Запуск игры…')
    const startT = Date.now()
    const onDone = () => { launching = false; launchUI(false); $('playState').textContent = 'Игра запущена'; try { gameProc.stdout.removeListener('data', tmp) } catch(e){} }
    const tmp = data => { if(GAME_LAUNCH_REGEX.test(String(data).trim())){ const d = Date.now() - startT; d < 5000 ? setTimeout(onDone, 5000 - d) : onDone() } }
    try {
        gameProc = pb.build()
        gameProc.stdout.on('data', tmp)
        $('playState').textContent = 'Готово, приятной игры!'
        gameProc.on('close', () => { gameProc = null })
    } catch(err){
        launchFail('ошибка запуска игры (см. консоль)')
    }
}
$('btnPlay').onclick = play

// старт
window.addEventListener('DOMContentLoaded', init)
if(document.readyState !== 'loading') init()
