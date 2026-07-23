const { DistributionAPI } = require('helios-core/common')
const got = require('got')
const fs = require('fs')

const ConfigManager = require('./configmanager')

exports.REMOTE_DISTRO_URL = 'https://stuffy-man.github.io/esketit-dist/distribution.json'
exports.REMOTE_DISTRO_URLS = [
    exports.REMOTE_DISTRO_URL,
    'https://raw.githubusercontent.com/stuffy-man/esketit-dist/main/distribution.json'
]

const api = new DistributionAPI(
    ConfigManager.getLauncherDirectory(),
    null, // Injected forcefully by the preloader.
    null, // Injected forcefully by the preloader.
    exports.REMOTE_DISTRO_URL,
    false
)

// helios-core accepts one distribution URL. Keep its cache/fallback behaviour,
// but try both independent GitHub delivery paths before using the local copy.
api.pullRemote = async function(){
    for(const url of exports.REMOTE_DISTRO_URLS){
        try {
            const body = (await got.get(url, {
                responseType: 'json',
                timeout: { request: 12000 },
                retry: { limit: 2 }
            })).body
            if(!body || !Array.isArray(body.servers)) throw new Error('Некорректный distribution.json')
            return { data: body, responseStatus: 0 }
        } catch(err){
            console.warn(`[Distribution] source failed: ${url}`, err.message || err)
        }
    }
    return { data: null, responseStatus: 1 }
}

// Never leave a truncated distribution cache after an interrupted write.
api.writeDistributionToDisk = async function(distribution){
    const temporary = `${this.distroPath}.part-${process.pid}`
    await fs.promises.mkdir(require('path').dirname(this.distroPath), { recursive: true })
    await fs.promises.writeFile(temporary, JSON.stringify(distribution, null, 2))
    await fs.promises.rename(temporary, this.distroPath)
}

exports.DistroAPI = api
