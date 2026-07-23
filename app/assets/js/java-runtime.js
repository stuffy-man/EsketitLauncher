const fs = require('fs')
const path = require('path')
const os = require('os')
const { execFile } = require('child_process')
const { promisify } = require('util')
const semver = require('semver')
const {
    discoverBestJvmInstallation,
    javaExecFromRoot
} = require('helios-core/java')

const execFileAsync = promisify(execFile)

function executableFromHome(home){
    if(!home) return null
    const clean = String(home).trim().replace(/^"(.*)"$/, '$1')
    if(process.platform === 'win32'){
        const javaw = path.join(clean, 'bin', 'javaw.exe')
        return fs.existsSync(javaw) ? javaw : path.join(clean, 'bin', 'java.exe')
    }
    if(process.platform === 'darwin' && clean.endsWith('.jdk')){
        return path.join(clean, 'Contents', 'Home', 'bin', 'java')
    }
    return path.join(clean, 'bin', 'java')
}

function addDirectoryChildren(candidates, directory, suffix){
    try {
        for(const name of fs.readdirSync(directory)){
            candidates.push(path.join(directory, name, ...suffix))
        }
    } catch(_err){ /* optional installation directory */ }
}

async function commandOutput(command, args){
    try {
        const { stdout } = await execFileAsync(command, args, {
            windowsHide: true,
            timeout: 5000,
            maxBuffer: 1024 * 1024
        })
        return String(stdout).split(/\r?\n/).map(line => line.trim()).filter(Boolean)
    } catch(_err){
        return []
    }
}

async function extraJavaCandidates(dataDir){
    const candidates = []
    for(const key of ['JAVA_HOME', 'JRE_HOME', 'JDK_HOME']){
        candidates.push(executableFromHome(process.env[key]))
    }

    const executableNames = process.platform === 'win32'
        ? ['javaw.exe', 'java.exe']
        : ['java']
    for(const directory of String(process.env.PATH || '').split(path.delimiter)){
        if(!directory) continue
        for(const name of executableNames) candidates.push(path.join(directory.replace(/^"(.*)"$/, '$1'), name))
    }

    if(process.platform === 'win32'){
        const roots = [
            process.env.ProgramFiles,
            process.env['ProgramFiles(x86)'],
            process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs')
        ].filter(Boolean)
        const vendors = ['Java', 'Eclipse Adoptium', 'AdoptOpenJDK', 'Amazon Corretto', 'BellSoft', 'Zulu', 'Microsoft']
        for(const root of roots){
            for(const vendor of vendors){
                addDirectoryChildren(candidates, path.join(root, vendor), ['bin', 'javaw.exe'])
                // Microsoft and some vendors add one extra product directory.
                try {
                    for(const product of fs.readdirSync(path.join(root, vendor))){
                        addDirectoryChildren(candidates, path.join(root, vendor, product), ['bin', 'javaw.exe'])
                    }
                } catch(_err){ /* optional */ }
            }
        }
        candidates.push(...await commandOutput('where.exe', ['java.exe']))
    } else if(process.platform === 'darwin'){
        for(const home of await commandOutput('/usr/libexec/java_home', ['-v', '17'])){
            candidates.push(executableFromHome(home))
        }
        addDirectoryChildren(candidates, '/Library/Java/JavaVirtualMachines', ['Contents', 'Home', 'bin', 'java'])
        candidates.push(
            '/opt/homebrew/opt/openjdk@17/bin/java',
            '/usr/local/opt/openjdk@17/bin/java',
            '/opt/homebrew/bin/java',
            '/usr/local/bin/java'
        )
    } else if(process.platform === 'linux'){
        candidates.push(...await commandOutput('sh', ['-c', 'command -v java || true']))
        candidates.push(...await commandOutput('update-alternatives', ['--list', 'java']))
        for(const directory of ['/usr/lib/jvm', '/usr/java', '/opt/java', path.join(os.homedir(), '.sdkman', 'candidates', 'java')]){
            addDirectoryChildren(candidates, directory, ['bin', 'java'])
        }
    }

    addDirectoryChildren(candidates, path.join(dataDir, 'runtime', process.arch), ['bin', process.platform === 'win32' ? 'javaw.exe' : 'java'])
    return [...new Set(candidates.filter(Boolean))]
}

async function validateJavaExecutable(executable, supportedRange){
    if(!executable || !fs.existsSync(executable)) return null
    try {
        const command = process.platform === 'win32' && executable.toLowerCase().endsWith('javaw.exe')
            ? executable.slice(0, -'javaw.exe'.length) + 'java.exe'
            : executable
        const { stderr } = await execFileAsync(command, ['-XshowSettings:properties', '-version'], {
            windowsHide: true,
            timeout: 10000,
            maxBuffer: 2 * 1024 * 1024
        })
        const properties = {}
        for(const line of String(stderr).split(/\r?\n/)){
            const match = line.match(/^\s*([^=]+?)\s*=\s*(.+)\s*$/)
            if(match) properties[match[1].trim()] = match[2].trim()
        }
        const version = properties['java.version']
        const bits = properties['sun.arch.data.model']
        if(!version || bits !== '64' || !semver.satisfies(semver.coerce(version), supportedRange)) return null
        if(process.arch === 'arm64' && !/aarch64|arm64/i.test(properties['os.arch'] || '')) return null
        return {
            executable,
            version,
            vendor: properties['java.vendor'] || 'unknown'
        }
    } catch(_err){
        return null
    }
}

async function discoverCompatibleJava(dataDir, supportedRange){
    for(const candidate of await extraJavaCandidates(dataDir)){
        const valid = await validateJavaExecutable(candidate, supportedRange)
        if(valid) return valid
    }

    // Keep helios-core's Windows registry and standard OS directory discovery
    // as the final broad scan.
    const discovered = await discoverBestJvmInstallation(dataDir, supportedRange)
    if(!discovered) return null
    const executable = javaExecFromRoot(discovered.path)
    return await validateJavaExecutable(executable, supportedRange)
}

function managedRuntimeSources(major, platform = process.platform, nodeArchitecture = process.arch){
    const architecture = nodeArchitecture === 'arm64' ? 'aarch64' : 'x64'
    const sources = []
    let adoptiumOS
    let extension
    let correttoOS

    switch(platform){
        case 'win32':
            adoptiumOS = 'windows'
            correttoOS = 'windows'
            extension = 'zip'
            if(architecture === 'x64' && major === 17){
                sources.push('https://github.com/stuffy-man/esketit-dist/releases/download/runtime/OpenJDK17U-jre_x64_windows_hotspot_17.0.19_10.zip')
            }
            break
        case 'darwin':
            adoptiumOS = 'mac'
            correttoOS = 'macos'
            extension = 'tar.gz'
            break
        case 'linux':
            adoptiumOS = 'linux'
            correttoOS = 'linux'
            extension = 'tar.gz'
            break
        default:
            throw new Error(`Операционная система ${platform} пока не поддерживается`)
    }

    sources.push(
        `https://api.adoptium.net/v3/binary/latest/${major}/ga/${adoptiumOS}/${architecture}/jre/hotspot/normal/eclipse?project=jdk`,
        `https://corretto.aws/downloads/latest/amazon-corretto-${major}-${architecture}-${correttoOS}-jdk.${extension}`
    )
    return {
        urls: sources,
        filename: `esketit-java-${major}-${platform}-${architecture}.${extension}`
    }
}

module.exports = {
    discoverCompatibleJava,
    managedRuntimeSources,
    validateJavaExecutable
}
