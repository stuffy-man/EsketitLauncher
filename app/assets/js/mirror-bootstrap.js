/**
 * Network hardening shared by the renderer and helios-core's repair child.
 *
 * - writes downloads to a temporary file and only replaces the destination
 *   after a complete response;
 * - retries another endpoint when the primary host is unavailable;
 * - validates repair assets after every endpoint, so an untrusted public
 *   mirror can never silently replace a mod/library.
 */
const fs = require('fs')
const fsp = fs.promises
const path = require('path')
const { pipeline } = require('stream/promises')
const got = require('got')

function unique(values){
    return [...new Set(values.filter(Boolean))]
}

function mirrorUrls(url){
    const urls = [url]

    if(url.startsWith('https://stuffy-man.github.io/esketit-dist/')){
        urls.push(url.replace(
            'https://stuffy-man.github.io/esketit-dist/',
            'https://raw.githubusercontent.com/stuffy-man/esketit-dist/main/'
        ))
    } else if(url.startsWith('https://raw.githubusercontent.com/stuffy-man/esketit-dist/main/')){
        urls.push(url.replace(
            'https://raw.githubusercontent.com/stuffy-man/esketit-dist/main/',
            'https://stuffy-man.github.io/esketit-dist/'
        ))
    }

    const replacements = [
        ['https://resources.download.minecraft.net/', 'https://bmclapi2.bangbang93.com/assets/'],
        ['https://libraries.minecraft.net/', 'https://bmclapi2.bangbang93.com/maven/'],
        ['https://maven.minecraftforge.net/', 'https://bmclapi2.bangbang93.com/maven/'],
        ['https://files.minecraftforge.net/maven/', 'https://bmclapi2.bangbang93.com/maven/'],
        ['https://piston-meta.mojang.com/', 'https://bmclapi2.bangbang93.com/'],
        ['https://launchermeta.mojang.com/', 'https://bmclapi2.bangbang93.com/']
    ]
    for(const [primary, mirror] of replacements){
        if(url.startsWith(primary)) urls.push(url.replace(primary, mirror))
    }

    // The distribution artifacts carry a mandatory hash in distribution.json.
    // ghfast is only tried after GitHub itself and is accepted only if that hash
    // matches in downloadAsset().
    if(url.startsWith('https://github.com/stuffy-man/esketit-dist/releases/download/')){
        urls.push(`https://ghfast.top/${url}`)
    }

    return unique(urls)
}

async function removeIfExists(file){
    try { await fsp.unlink(file) } catch(err){ if(err.code !== 'ENOENT') throw err }
}

async function downloadOneAtomic(url, destination, onProgress){
    await fsp.mkdir(path.dirname(destination), { recursive: true })
    const temporary = `${destination}.part-${process.pid}-${Math.random().toString(16).slice(2)}`
    try {
        const stream = got.stream(url, {
            timeout: { request: 45000 },
            retry: {
                limit: 2,
                methods: ['GET'],
                statusCodes: [408, 413, 429, 500, 502, 503, 504]
            },
            headers: { 'user-agent': 'EsketitLauncher/1' }
        })
        if(onProgress){
            stream.on('downloadProgress', progress => onProgress(progress))
        }
        await pipeline(stream, fs.createWriteStream(temporary, { flags: 'wx' }))
        await fsp.rename(temporary, destination)
    } catch(err){
        await removeIfExists(temporary)
        throw err
    }
}

async function downloadWithMirrors(urlOrUrls, destination, onProgress){
    const candidates = unique(
        (Array.isArray(urlOrUrls) ? urlOrUrls : [urlOrUrls]).flatMap(mirrorUrls)
    )
    const errors = []
    for(const url of candidates){
        try {
            if(onProgress) onProgress({ transferred: 0, percent: 0, total: 0 })
            await downloadOneAtomic(url, destination, onProgress)
            return url
        } catch(err){
            errors.push(`${url}: ${err.message || err}`)
            console.warn(`[Mirror] download failed, trying next endpoint: ${url}`, err.message || err)
        }
    }
    throw new Error(`Все источники загрузки недоступны:\n${errors.join('\n')}`)
}

function installHeliosDownloadPatch(){
    let engine
    try {
        const coreDist = path.dirname(require.resolve('helios-core'))
        engine = require(path.join(coreDist, 'dl', 'DownloadEngine.js'))
    } catch(err){
        console.warn('[Mirror] helios-core download patch was not installed:', err.message)
        return
    }
    if(engine.__esketitMirrorPatch) return

    const coreDist = path.dirname(require.resolve('helios-core'))
    const { validateLocalFile } = require(path.join(coreDist, 'common', 'util', 'FileUtils.js'))
    const fastq = require('fastq')

    engine.downloadFile = downloadWithMirrors
    engine.downloadQueue = async function(assets, onProgress){
        const received = new Array(assets.length).fill(0)
        const receivedById = {}
        const report = (index, amount) => {
            received[index] = amount
            onProgress(received.reduce((sum, value) => sum + value, 0))
        }
        const worker = async ({ asset, index }) => {
            const candidates = mirrorUrls(asset.url)
            const failures = []
            for(const url of candidates){
                try {
                    report(index, 0)
                    await downloadOneAtomic(url, asset.path, progress => {
                        report(index, progress.transferred || 0)
                    })
                    if(!await validateLocalFile(asset.path, asset.algo, asset.hash)){
                        await removeIfExists(asset.path)
                        throw new Error('контрольная сумма не совпала')
                    }
                    report(index, asset.size)
                    receivedById[asset.id] = asset.size
                    return
                } catch(err){
                    failures.push(`${url}: ${err.message || err}`)
                    console.warn(`[Mirror] invalid/unavailable asset source: ${url}`, err.message || err)
                }
            }
            throw new Error(`Не удалось скачать ${asset.id}:\n${failures.join('\n')}`)
        }
        const queue = fastq.promise(worker, 8)
        await Promise.all(assets.map((asset, index) => queue.push({ asset, index })))
        return receivedById
    }
    engine.__esketitMirrorPatch = true
}

function installMojangMetadataPatch(){
    let MojangIndexProcessor
    try {
        const coreDist = path.dirname(require.resolve('helios-core'))
        MojangIndexProcessor = require(path.join(coreDist, 'dl', 'mojang', 'MojangIndexProcessor.js')).MojangIndexProcessor
    } catch(err){
        console.warn('[Mirror] Mojang metadata patch was not installed:', err.message)
        return
    }
    if(MojangIndexProcessor.prototype.__esketitMirrorPatch) return

    const originalLoadContent = MojangIndexProcessor.prototype.loadContentWithRemoteFallback
    MojangIndexProcessor.prototype.loadContentWithRemoteFallback = async function(url, target, hash){
        for(const candidate of mirrorUrls(url)){
            const result = await originalLoadContent.call(this, candidate, target, hash)
            if(result != null) return result
        }
        return null
    }
    MojangIndexProcessor.prototype.loadVersionManifest = async function(){
        for(const url of mirrorUrls(MojangIndexProcessor.VERSION_MANIFEST_ENDPOINT)){
            try {
                return (await this.client.get(url)).body
            } catch(err){
                console.warn(`[Mirror] version manifest source failed: ${url}`, err.message || err)
            }
        }
        return null
    }
    MojangIndexProcessor.prototype.__esketitMirrorPatch = true
}

installHeliosDownloadPatch()
installMojangMetadataPatch()

module.exports = {
    downloadWithMirrors,
    mirrorUrls
}
