"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const mime_1 = __importDefault(require("mime"));
const utils = __importStar(require("@iobroker/adapter-core"));
/**
 * ProxyEufySecurity class
 *
 * Reads files from localhost server
 *
 * @class
 * @param {object} server http or https node.js object
 * @param {object} webSettings settings of the web server, like <pre><code>{secure: settings.secure, port: settings.port}</code></pre>
 * @param {object} adapter web adapter object
 * @param {object} instanceSettings instance object with common and native
 * @param {object} app express application
 * @return {object} object instance
 */
class ProxyEufySecurity {
    constructor(server, webSettings, adapter, instanceSettings, app) {
        this.app = app;
        this.config = instanceSettings ? instanceSettings.native : {};
        this.namespace = instanceSettings ? instanceSettings._id.substring("system.adapter.".length) : "eufy-security";
        this.config.route = this.config.route || (this.namespace + "/");
        this.config.port = parseInt(this.config.port, 10) || 80;
        // remove leading slash
        if (this.config.route[0] === "/") {
            this.config.route = this.config.route.substr(1);
        }
        const root_path = path_1.default.join(utils.getAbsoluteDefaultDataDir(), this.namespace);
        this.app.use("/" + this.config.route, (req, res) => {
            const fileName = path_1.default.join(root_path, req.url.substring(1));
            const normalized_filename = path_1.default.resolve(fileName);
            if (normalized_filename.startsWith(root_path)) {
                res.setHeader("Access-Control-Allow-Origin", "*");
                res.setHeader("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
                if (fs_1.default.existsSync(normalized_filename)) {
                    const stat = fs_1.default.statSync(normalized_filename);
                    if (!stat.isDirectory()) {
                        let data;
                        try {
                            data = fs_1.default.readFileSync(normalized_filename);
                        }
                        catch (e) {
                            res.status(500).send(`[eufy-security] Cannot read file: ${e}`);
                            return;
                        }
                        res.contentType(mime_1.default.getType(path_1.default.extname(normalized_filename).substring(1)) || "html");
                        res.status(200).send(data);
                    }
                }
                else {
                    res.status(404).send('[eufy-security] File "' + normalized_filename + '" not found.');
                }
            }
            else {
                res.status(403).send('[eufy-security] Access to file "' + normalized_filename + '" denied.');
            }
        });
    }
}
module.exports = ProxyEufySecurity;
//# sourceMappingURL=web.js.map