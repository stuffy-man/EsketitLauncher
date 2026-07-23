const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const got = require('got')

const { FullRepair } = require('helios-core/dl')
const { downloadWithMirrors, mirrorUrls } = require('../app/assets/js/mirror-bootstrap')
const { discoverCompatibleJava, managedRuntimeSources } = require('../app/assets/js/java-runtime')

async function verifyEndpoints(){
    const endpoints = [
        'https://stuffy-man.github.io/esketit-dist/distribution.json',
        'https://raw.githubusercontent.com/stuffy-man/esketit-dist/main/distribution.json'
    ]
    const distributions = []
    for(const url of endpoints){
        const body = (await got(url, {
            responseType: 'json',
            timeout: { request: 15000 },
            retry: { limit: 1 }
        })).body
        assert(Array.isArray(body.servers) && body.servers.length > 0, `${url} returned no servers`)
        distributions.push(body)
    }
    assert.strictEqual(distributions[0].version, distributions[1].version)
    assert.strictEqual(distributions[0].servers[0].id, distributions[1].servers[0].id)
}

async function verifyAtomicDownload(){
    const target = path.join(os.tmpdir(), `esketit-news-${process.pid}.json`)
    try {
        await downloadWithMirrors([
            'https://stuffy-man.github.io/esketit-dist/news.json',
            'https://raw.githubusercontent.com/stuffy-man/esketit-dist/main/news.json'
        ], target)
        JSON.parse(await fs.promises.readFile(target, 'utf8'))
        const leftovers = (await fs.promises.readdir(path.dirname(target)))
            .filter(name => name.startsWith(path.basename(target) + '.part-'))
        assert.strictEqual(leftovers.length, 0, 'temporary download files were not cleaned')
    } finally {
        await fs.promises.unlink(target).catch(() => {})
    }
}

async function verifyReceiver(){
    const appData = process.env.APPDATA
    if(!appData) throw new Error('APPDATA is required for the local receiver smoke test')
    const fullRepair = new FullRepair(
        path.join(appData, '.esketitlauncher', 'common'),
        path.join(appData, '.esketitlauncher', 'instances'),
        path.join(appData, 'Esketit Launcher'),
        'esketit-1.20.1',
        false
    )
    const bootstrap = path.resolve(__dirname, '..', 'app', 'assets', 'js', 'mirror-bootstrap.js').replace(/\\/g, '/')
    fullRepair.spawnReceiver({ NODE_OPTIONS: `--require="${bootstrap}"` })
    try {
        const invalid = await fullRepair.verifyFiles(() => {})
        console.log(`repair receiver: ${invalid} invalid/missing file(s)`)
    } finally {
        fullRepair.destroyReceiver()
    }
}

async function main(){
    assert(mirrorUrls('https://resources.download.minecraft.net/aa/bb')
        .includes('https://bmclapi2.bangbang93.com/assets/aa/bb'))
    assert(mirrorUrls('https://stuffy-man.github.io/esketit-dist/repo/test.jar')
        .includes('https://raw.githubusercontent.com/stuffy-man/esketit-dist/main/repo/test.jar'))

    const supportedTargets = [
        ['win32', 'x64'],
        ['linux', 'x64'],
        ['linux', 'arm64'],
        ['darwin', 'x64'],
        ['darwin', 'arm64']
    ]
    for(const [platform, architecture] of supportedTargets){
        const source = managedRuntimeSources(17, platform, architecture)
        assert(source.urls.length >= 2, `not enough Java sources for ${platform}/${architecture}`)
        assert(source.filename.includes(platform))
    }

    const java = await discoverCompatibleJava(
        path.join(process.env.APPDATA || os.homedir(), '.esketitlauncher'),
        '>=17'
    )
    assert(java, 'no compatible Java was discovered on this machine')
    console.log(`java: ${java.version} (${java.vendor}) at ${java.executable}`)

    await Promise.all([verifyEndpoints(), verifyAtomicDownload()])
    console.log('distribution and mirror endpoints: OK')

    if(process.argv.includes('--receiver')) await verifyReceiver()
}

main().catch(err => {
    console.error(err)
    process.exitCode = 1
})
