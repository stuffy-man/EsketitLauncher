const { DistributionAPI } = require('helios-core/common')

const ConfigManager = require('./configmanager')

// TODO: заменить на URL, где будет размещён distribution.json сервера Esketit
// (генерируется Nebula, выкладывается на CDN/веб-хостинг).
exports.REMOTE_DISTRO_URL = 'https://stuffy-man.github.io/esketit-dist/distribution.json'

const api = new DistributionAPI(
    ConfigManager.getLauncherDirectory(),
    null, // Injected forcefully by the preloader.
    null, // Injected forcefully by the preloader.
    exports.REMOTE_DISTRO_URL,
    false
)

exports.DistroAPI = api