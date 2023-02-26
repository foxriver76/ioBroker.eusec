/*
 * Created with @iobroker/create-adapter v1.28.0
 */

import * as utils from "@iobroker/adapter-core";
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { strict } from "assert";
import { spawn } from "child_process";
import * as path from "path";
import {
    Camera,
    Device,
    Station,
    PushMessage,
    P2PConnectionType,
    EufySecurity,
    EufySecurityConfig,
    CommandResult,
    CommandType,
    ErrorCode,
    PropertyValue,
    PropertyName,
    StreamMetadata,
    PropertyMetadataNumeric,
    PropertyMetadataAny,
    CommandName,
    PanTiltDirection,
    DeviceNotFoundError,
    LoginOptions,
    TalkbackStream
} from "eufy-security-client";
import { getAlpha2Code as getCountryCode } from "i18n-iso-countries"
import { isValid as isValidLanguageCode } from "@cospired/i18n-iso-languages"
import fse from "fs-extra";
import { Readable } from "stream";
import util from "util";

import * as Interface from "./lib/interfaces"
import { CameraStateID, DataLocation, IMAGE_FILE_JPEG_EXT, IndoorCameraStateID, LockStateID, RoleMapping, SmartSafeStateID, StationStateID, StoppablePromise, STREAM_FILE_NAME_EXT } from "./lib/types";
import { convertCamelCaseToSnakeCase, getDataFilePath, getImageAsHTML, getVideoClipLength, handleUpdate, isEmpty, moveFiles, removeFiles, removeLastChar, setStateAsync, sleep, setStateChangedAsync } from "./lib/utils";
import { PersistentData } from "./lib/interfaces";
import { ioBrokerLogger } from "./lib/log";
import { ffmpegPreviewImage, ffmpegRTMPToHls, ffmpegStreamToHls } from "./lib/video";

// Augment the adapter.config object with the actual types
// TODO: delete this in the next version
declare global {
    // eslint-disable-next-line @typescript-eslint/no-namespace
    namespace ioBroker {
        // eslint-disable-next-line @typescript-eslint/no-empty-interface
        interface AdapterConfig extends Interface.AdapterConfig{
            // Define the shape of your options here (recommended)
            // Or use a catch-all approach
            //[key: string]: any;
        }
    }
}

export class euSec extends utils.Adapter {

    private eufy!: EufySecurity;
    private downloadEvent: {
        [index: string]: NodeJS.Timeout;
    } = {};

    private persistentFile: string;
    private logger!: ioBrokerLogger;
    private persistentData: PersistentData = {
        version: ""
    };
    private rtmpFFmpegPromise: Map<string, StoppablePromise> = new Map<string, StoppablePromise>();
    private captchaId: string | null = null;
    private verify_code = false;

    public constructor(options: Partial<utils.AdapterOptions> = {}) {
        super({
            ...options,
            name: "eusec",
        });
        const data_dir = utils.getAbsoluteInstanceDataDir(this);
        this.persistentFile = path.join(data_dir, "adapter.json");

        if (!fse.existsSync(data_dir))
            fse.mkdirSync(data_dir);

        this.on("ready", this.onReady.bind(this));
        this.on("stateChange", this.onStateChange.bind(this));
        // this.on("objectChange", this.onObjectChange.bind(this));
        this.on("message", this.onMessage.bind(this));
        this.on("unload", this.onUnload.bind(this));
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    private async onReady(): Promise<void> {

        this.logger = new ioBrokerLogger(this.log);

        await this.setObjectNotExistsAsync("verify_code", {
            type: "state",
            common: {
                name: "2FA verification code",
                type: "string",
                role: "state",
                read: true,
                write: true,
            },
            native: {},
        });
        await this.setObjectNotExistsAsync("received_captcha_html", {
            type: "state",
            common: {
                name: "Received captcha image HTML",
                type: "string",
                role: "state",
                read: true,
                write: false,
            },
            native: {},
        });
        await this.setObjectNotExistsAsync("captcha", {
            type: "state",
            common: {
                name: "Enter captcha",
                type: "string",
                role: "state",
                read: true,
                write: true,
            },
            native: {},
        });
        await this.setObjectNotExistsAsync("info", {
            type: "channel",
            common: {
                name: "info"
            },
            native: {},
        });
        await this.setObjectNotExistsAsync("info.connection", {
            type: "state",
            common: {
                name: "Global connection",
                type: "boolean",
                role: "indicator.connection",
                read: true,
                write: false,
            },
            native: {},
        });
        await this.setStateAsync("info.connection", { val: false, ack: true });
        await this.setObjectNotExistsAsync("info.push_connection", {
            type: "state",
            common: {
                name: "Push notification connection",
                type: "boolean",
                role: "indicator.connection",
                read: true,
                write: false,
            },
            native: {},
        });
        await this.setStateAsync("info.push_connection", { val: false, ack: true });
        await this.setObjectNotExistsAsync("info.mqtt_connection", {
            type: "state",
            common: {
                name: "MQTT connection",
                type: "boolean",
                role: "indicator.connection",
                read: true,
                write: false,
            },
            native: {},
        });
        await this.setStateAsync("info.mqtt_connection", { val: false, ack: true });

        try {
            const connection = await this.getStatesAsync("*.connection");
            if (connection)
                Object.keys(connection).forEach(async id => {
                    await this.setStateAsync(id, { val: false, ack: true });
                });
        } catch (error) {
            this.logger.error("Reset connection states - Error", error);
        }

        try {
            const sensorList = [
                PropertyName.DeviceMotionDetected,
                PropertyName.DevicePersonDetected,
                PropertyName.DeviceSoundDetected,
                PropertyName.DeviceCryingDetected,
                PropertyName.DevicePetDetected,
                PropertyName.DeviceRinging
            ];
            for(const sensorName of sensorList) {
                const sensors = await this.getStatesAsync(`*.${convertCamelCaseToSnakeCase(sensorName)}`);
                if (sensors)
                    Object.keys(sensors).forEach(async id => {
                        await this.setStateAsync(id, { val: false, ack: true });
                    });
            }
        } catch (error) {
            this.logger.error("Reset sensor states - Error", error);
        }

        try {
            if (fse.statSync(this.persistentFile).isFile()) {
                const fileContent = fse.readFileSync(this.persistentFile, "utf8");
                this.persistentData = JSON.parse(fileContent) as PersistentData;
            }
        } catch (error) {
            this.logger.debug("No stored data from last exit found.", error);
        }

        this.subscribeStates("verify_code");
        this.subscribeStates("captcha");

        const systemConfig = await this.getForeignObjectAsync("system.config");
        let countryCode = undefined;
        let languageCode = undefined;
        if (systemConfig) {
            countryCode = getCountryCode(systemConfig.common.country, "en");
            if (isValidLanguageCode(systemConfig.common.language))
                languageCode = systemConfig.common.language;
        }
        // Handling adapter version update
        try {
            if (this.persistentData.version !== this.version) {
                const currentVersion = Number.parseFloat(removeLastChar(this.version, "."));
                const previousVersion = this.persistentData.version !== "" && this.persistentData.version !== undefined ? Number.parseFloat(removeLastChar(this.persistentData.version, ".")) : 0;
                this.logger.debug(`Handling of adapter update - currentVersion: ${currentVersion} previousVersion: ${previousVersion}`);

                if (previousVersion < currentVersion) {
                    await handleUpdate(this, this.logger, previousVersion);
                    this.persistentData.version = this.version;
                    this.writePersistentData();
                }
            }
        } catch (error) {
            this.logger.error(`Handling of adapter update - Error:`, error);
        }

        let connectionType = P2PConnectionType.QUICKEST;
        if (this.config.p2pConnectionType === "only_local") {
            connectionType = P2PConnectionType.ONLY_LOCAL;
        }

        const config: EufySecurityConfig = {
            username: this.config.username,
            password: this.config.password,
            country: countryCode,
            language: languageCode,
            persistentDir: utils.getAbsoluteInstanceDataDir(this),
            eventDurationSeconds: this.config.eventDuration,
            p2pConnectionSetup: connectionType,
            pollingIntervalMinutes: this.config.pollingInterval,
            acceptInvitations: this.config.acceptInvitations,
            //trustedDeviceName: "IOBROKER",
        };

        this.eufy = await EufySecurity.initialize(config, this.logger);
        this.eufy.on("station added", (station: Station) => this.onStationAdded(station));
        this.eufy.on("device added", (device: Device) => this.onDeviceAdded(device));
        this.eufy.on("station removed", (station: Station) => this.onStationRemoved(station));
        this.eufy.on("device removed", (device: Device) => this.onDeviceRemoved(device));
        this.eufy.on("push message", (messages) => this.handlePushNotification(messages));
        this.eufy.on("push connect", () => this.onPushConnect());
        this.eufy.on("push close", () => this.onPushClose());
        this.eufy.on("mqtt connect", () => this.onMQTTConnect());
        this.eufy.on("mqtt close", () => this.onMQTTClose());
        this.eufy.on("connect", () => this.onConnect());
        this.eufy.on("close", () => this.onClose());

        this.eufy.on("cloud livestream start", (station: Station, device: Device, url: string) => this.onCloudLivestreamStart(station, device, url));
        this.eufy.on("cloud livestream stop", (station: Station, device: Device) => this.onCloudLivestreamStop(station, device));
        this.eufy.on("device property changed", (device: Device, name: string, value: PropertyValue) => this.onDevicePropertyChanged(device, name, value));

        this.eufy.on("station command result", (station: Station, result: CommandResult) => this.onStationCommandResult(station, result));
        this.eufy.on("station download start", (station: Station, device: Device, metadata: StreamMetadata, videostream: Readable, audiostream: Readable) => this.onStationDownloadStart(station, device, metadata, videostream, audiostream));
        this.eufy.on("station download finish", (station: Station, device: Device) => this.onStationDownloadFinish(station, device));
        this.eufy.on("station livestream start", (station: Station, device: Device, metadata: StreamMetadata, videostream: Readable, audiostream: Readable) => this.onStationLivestreamStart(station, device, metadata, videostream, audiostream));
        this.eufy.on("station livestream stop", (station: Station, device: Device) => this.onStationLivestreamStop(station, device));
        this.eufy.on("station rtsp url",  (station: Station, device: Device, value: string) => this.onStationRTSPUrl(station, device, value));
        this.eufy.on("station property changed", (station: Station, name: string, value: PropertyValue) => this.onStationPropertyChanged(station, name, value));
        this.eufy.on("station connect", (station: Station) => this.onStationConnect(station));
        this.eufy.on("station close", (station: Station) => this.onStationClose(station));
        this.eufy.on("tfa request", () => this.onTFARequest());
        this.eufy.on("captcha request", (captchaId: string, captcha: string) => this.onCaptchaRequest(captchaId, captcha));
        this.eufy.setCameraMaxLivestreamDuration(this.config.maxLivestreamDuration);

        await this.eufy.connect();
    }

    public writePersistentData(): void {
        try {
            fse.writeFileSync(this.persistentFile, JSON.stringify(this.persistentData));
        } catch (error) {
            this.logger.error(`writePersistentData() - Error: ${error}`);
        }
    }

    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     */
    private async onUnload(callback: () => void): Promise<void> {
        try {

            this.writePersistentData();

            if (this.eufy) {
                this.eufy.removeAllListeners();
                this.eufy.close();
            }

            callback();
        } catch (e) {
            callback();
        }
    }

    // If you need to react to object changes, uncomment the following block and the corresponding line in the constructor.
    // You also need to subscribe to the objects with `this.subscribeObjects`, similar to `this.subscribeStates`.
    // /**
    //  * Is called if a subscribed object changes
    //  */
    // private onObjectChange(id: string, obj: ioBroker.Object | null | undefined): void {
    //     if (obj) {
    //         // The object was changed
    //         this.log.info(`object ${id} changed: ${JSON.stringify(obj)}`);
    //     } else {
    //         // The object was deleted
    //         this.log.info(`object ${id} deleted`);
    //     }
    // }

    /**
     * Is called if a subscribed state changes
     */
    private async onStateChange(id: string, state: ioBroker.State | null | undefined): Promise<void> {
        if (state) {

            // don't do anything if the state is acked
            if (!id || state.ack) {
                this.logger.debug(`state ${id} changed: ${state.val} (ack = ${state.ack}) was already acknowledged, ignore it...`);
                return;
            }
            this.logger.debug(`state ${id} changed: ${state.val} (ack = ${state.ack})`);

            const values = id.split(".");
            const station_sn = values[2];
            const device_type = values[3];

            if (station_sn == "verify_code") {
                if (this.eufy && this.verify_code) {
                    this.logger.info(`Verification code received, send it. (verify_code: ${state.val})`);
                    await this.eufy.connect({ verifyCode: state.val as string } as LoginOptions);
                    this.verify_code = false;
                    await this.delStateAsync(id);
                }
            } else if (station_sn == "captcha") {
                if (this.eufy && this.captchaId) {
                    this.logger.info(`Captcha received, send it. (captcha: ${state.val})`);
                    await this.eufy.connect({
                        captcha: {
                            captchaCode: state.val as string,
                            captchaId: this.captchaId
                        }
                    } as LoginOptions);
                    this.captchaId = null;
                    await this.delStateAsync(id);
                    await this.delStateAsync("received_captcha_html");
                }
            } else if (device_type == "station") {
                try {
                    const station_state_name = values[4];
                    if (this.eufy) {
                        const obj = await this.getObjectAsync(id);
                        if (obj) {
                            if (obj.native.name !== undefined) {
                                await this.eufy.setStationProperty(station_sn, obj.native.name, state.val);
                                return;
                            }
                        }

                        const station = await this.eufy.getStation(station_sn);
                        switch(station_state_name) {
                            case StationStateID.REBOOT:
                                await station.rebootHUB();
                                break;
                            case StationStateID.TRIGGER_ALARM_SOUND:
                                await station.triggerStationAlarmSound(this.config.alarmSoundDuration);
                                break;
                            case StationStateID.RESET_ALARM_SOUND:
                                await station.resetStationAlarmSound();
                                break;
                        }
                    }
                } catch (error) {
                    this.logger.error(`station - Error:`, error);
                }
            } else {
                try {
                    const device_sn = values[4];
                    const obj = await this.getObjectAsync(id);
                    if (obj) {
                        if (obj.native.name !== undefined) {
                            try {
                                await this.eufy.setDeviceProperty(device_sn, obj.native.name, state.val);
                            } catch (error) {
                                this.logger.error(`Error in setting property value (property: ${obj.native.name} value: ${state.val})`, error);
                            }
                            return;
                        }
                    }

                    const device_state_name = values[5];
                    const station = await this.eufy.getStation(station_sn);
                    const device = await this.eufy.getDevice(device_sn);

                    switch(device_state_name) {
                        case CameraStateID.START_STREAM:
                            await this.startLivestream(device_sn);
                            break;
                        case CameraStateID.STOP_STREAM:
                            await this.stopLivestream(device_sn);
                            break;
                        case CameraStateID.TRIGGER_ALARM_SOUND:
                            await station.triggerDeviceAlarmSound(device, this.config.alarmSoundDuration);
                            break;
                        case CameraStateID.RESET_ALARM_SOUND:
                            await station.resetDeviceAlarmSound(device);
                            break;
                        case IndoorCameraStateID.ROTATE_360:
                            await station.panAndTilt(device, PanTiltDirection.ROTATE360);
                            break;
                        case IndoorCameraStateID.PAN_LEFT:
                            await station.panAndTilt(device, PanTiltDirection.LEFT);
                            break;
                        case IndoorCameraStateID.PAN_RIGHT:
                            await station.panAndTilt(device, PanTiltDirection.RIGHT);
                            break;
                        case IndoorCameraStateID.TILT_UP:
                            await station.panAndTilt(device, PanTiltDirection.UP);
                            break;
                        case IndoorCameraStateID.TILT_DOWN:
                            await station.panAndTilt(device, PanTiltDirection.DOWN);
                            break;
                        case LockStateID.CALIBRATE:
                            if (device.isLock()) {
                                await station.calibrateLock(device);
                            } else {
                                await station.calibrate(device);
                            }
                            break;
                        case SmartSafeStateID.UNLOCK:
                            await station.unlock(device);
                            break;
                        case IndoorCameraStateID.SET_DEFAULT_ANGLE:
                            await station.setDefaultAngle(device);
                            break;
                        case IndoorCameraStateID.SET_PRIVACY_ANGLE:
                            await station.setPrivacyAngle(device);
                            break;
                    }
                } catch (error) {
                    this.logger.error(`cameras - Error:`, error);
                }
            }
        } else {
            // The state was deleted
            this.logger.debug(`state ${id} deleted`);
        }
    }

    /**
     * Some message was sent to this instance over message box. Used by email, pushover, text2speech, ...
     * Using this method requires "common.message" property to be set to true in io-package.json
     */
    private async onMessage(obj: ioBroker.Message): Promise<void> {
        if (typeof obj === "object" && obj.message) {
            if (obj.command === "talkback" && typeof obj.message === "object") {
                const message = obj.message;
                const ffmpegPath = message.ffmpegPath;
                const mp3Path = message.mp3Path;

                this.log.info(`Talkback recevied: ${JSON.stringify(message)}`);

                const args = `-re -i ${mp3Path} -acodec aac -ac 1 -ar 16k -b:a 32k -f adts pipe:1`;

                // TODO: outsource in method
                // promise that waits for start of talkback stream and sends data
                const sendTalkbackPromise = new Promise<void>(resolve => {
                    const listenerFun = (async (station: Station, device: Device, talkbackStream: TalkbackStream) => {
                        this.eufy.removeListener("station talkback start", listenerFun);

                        const ffmpeg = spawn(ffmpegPath, args.split(/\s+/), { env: process.env });

                        ffmpeg.stdout.pipe(talkbackStream);

                        ffmpeg.on("error", (err) => {
                            this.log.info(`ffmpeg error: ${err}`);
                        });

                        ffmpeg.stderr.on("data", (data) => {
                            data.toString().split("\n").forEach((line: string) => {
                                if (line.length > 0) {
                                    this.log.debug(line);
                                }
                            });
                        });

                        ffmpeg.on("close", async () => {
                            this.log.info("ffmpeg closed.");
                            try {
                                await this.eufy.stopStationTalkback(message.deviceSN);
                            } catch (e: any) {
                                this.log.error(`Error stopping talkback stream: ${e.message}`)
                            }

                            resolve();
                        });
                    })

                    this.eufy.on("station talkback start", listenerFun);
                });

                try {
                    await this.eufy.startStationTalkback(message.deviceSN);
                    await sendTalkbackPromise;
                } catch (e: any) {
                    this.log.error(`Error starting talkback stream: ${e.message}`)
                }

                if (obj.callback) {
                    this.sendTo(obj.from, obj.command, "Talkback received", obj.callback);
                }
            } else {
                this.log.warn(`Unknown message command received: ${obj.command}`);
            }
        } else {
            this.log.warn(`Invalid message received; ${JSON.stringify(obj)}`);
        }
    }

    private getStateCommon(property: PropertyMetadataAny): ioBroker.StateCommon {
        const state: ioBroker.StateCommon = {
            name: property.label!,
            type: property.type,
            role: "state",
            read: property.readable,
            write: property.writeable,
            def: property.default
        };
        switch (property.type) {
            case "number": {
                const numberProperty = property as PropertyMetadataNumeric;
                state.min = numberProperty.min;
                state.max = numberProperty.max;
                state.states = numberProperty.states;
                state.unit = numberProperty.unit;
                state.step = numberProperty.steps;
                state.role = RoleMapping[property.name] !== undefined ? RoleMapping[property.name] : "value";
                break;
            }
            case "string": {
                state.role = RoleMapping[property.name] !== undefined ? RoleMapping[property.name] : "text";
                break;
            }
            case "boolean": {
                state.role = RoleMapping[property.name] !== undefined ? RoleMapping[property.name] : (property.writeable ? "switch.enable" : "state");
                break;
            }
        }
        return state;
    }

    private async createAndSetState(device: Device | Station, property: PropertyMetadataAny): Promise<void> {
        if (property.name !== PropertyName.Type && property.name !== PropertyName.DeviceStationSN) {
            const state = this.getStateCommon(property);
            const id: string = device.getStateID(convertCamelCaseToSnakeCase(property.name));
            const obj = await this.getObjectAsync(id);
            if (obj) {
                let changed = false;
                if (obj.native.name !== undefined && obj.native.name !== property.name) {
                    obj.native.name = property.name;
                    changed = true;
                }
                if (obj.native.key !== undefined && obj.native.key !== property.key) {
                    obj.native.key = property.key;
                    changed = true;
                }
                if (obj.native.commandId !== undefined && obj.native.commandId !== property.commandId) {
                    obj.native.commandId = property.commandId;
                    changed = true;
                }
                if (obj.common !== undefined && !util.isDeepStrictEqual(obj.common, state)) {
                    changed = true;
                }
                if (changed) {
                    const propertyMetadata = device.getPropertiesMetadata()[property.name];
                    if (propertyMetadata !== undefined) {
                        const newState = this.getStateCommon(propertyMetadata);
                        obj.common = newState;
                    }
                    await this.setObjectAsync(id, obj);
                }
            } else {
                await this.setObjectNotExistsAsync(id, {
                    type: "state",
                    common: state,
                    native: {
                        key: property.key,
                        commandId: property.commandId,
                        name: property.name,
                    },
                });
            }
            const value = device.getPropertyValue(property.name);
            if (value !== undefined)
                await setStateChangedAsync(this, id, property.type === "string" && typeof value === "object" ? JSON.stringify(value) : value);
        }
    }

    private async onDeviceAdded(device: Device): Promise<void> {
        //this.logger.debug(`count: ${Object.keys(devices).length}`);

        await this.setObjectNotExistsAsync(device.getStateID("", 0), {
            type: "channel",
            common: {
                name: device.getStateChannel()
            },
            native: {},
        });

        await this.setObjectNotExistsAsync(device.getStateID("", 1), {
            type: "device",
            common: {
                name: device.getName()
            },
            native: {},
        });

        const metadata = device.getPropertiesMetadata();
        for(const property of Object.values(metadata)) {
            this.createAndSetState(device, property);
        }

        if (device.hasCommand(CommandName.DeviceTriggerAlarmSound)) {
            await this.setObjectNotExistsAsync(device.getStateID(CameraStateID.TRIGGER_ALARM_SOUND), {
                type: "state",
                common: {
                    name: "Trigger Alarm Sound",
                    type: "boolean",
                    role: "button.start",
                    read: false,
                    write: true,
                },
                native: {},
            });
            await this.setObjectNotExistsAsync(device.getStateID(CameraStateID.RESET_ALARM_SOUND), {
                type: "state",
                common: {
                    name: "Reset Alarm Sound",
                    type: "boolean",
                    role: "button.start",
                    read: false,
                    write: true,
                },
                native: {},
            });
        }
        if (device.hasCommand(CommandName.DevicePanAndTilt)) {
            await this.setObjectNotExistsAsync(device.getStateID(IndoorCameraStateID.PAN_LEFT), {
                type: "state",
                common: {
                    name: "Pan Left",
                    type: "boolean",
                    role: "button.start",
                    read: false,
                    write: true,
                },
                native: {},
            });
            await this.setObjectNotExistsAsync(device.getStateID(IndoorCameraStateID.PAN_RIGHT), {
                type: "state",
                common: {
                    name: "Pan Right",
                    type: "boolean",
                    role: "button.start",
                    read: false,
                    write: true,
                },
                native: {},
            });
            await this.setObjectNotExistsAsync(device.getStateID(IndoorCameraStateID.ROTATE_360), {
                type: "state",
                common: {
                    name: "Rotate 360°",
                    type: "boolean",
                    role: "button.start",
                    read: false,
                    write: true,
                },
                native: {},
            });
            await this.setObjectNotExistsAsync(device.getStateID(IndoorCameraStateID.TILT_UP), {
                type: "state",
                common: {
                    name: "Tilt Up",
                    type: "boolean",
                    role: "button.start",
                    read: false,
                    write: true,
                },
                native: {},
            });
            await this.setObjectNotExistsAsync(device.getStateID(IndoorCameraStateID.TILT_DOWN), {
                type: "state",
                common: {
                    name: "Tilt Down",
                    type: "boolean",
                    role: "button.start",
                    read: false,
                    write: true,
                },
                native: {},
            });
        }
        if (device.hasCommand(CommandName.DeviceLockCalibration)) {
            await this.setObjectNotExistsAsync(device.getStateID(LockStateID.CALIBRATE), {
                type: "state",
                common: {
                    name: "Calibrate Lock",
                    type: "boolean",
                    role: "button.start",
                    read: false,
                    write: true,
                },
                native: {},
            });
        }
        if (device.hasCommand(CommandName.DeviceUnlock)) {
            await this.setObjectNotExistsAsync(device.getStateID(SmartSafeStateID.UNLOCK), {
                type: "state",
                common: {
                    name: "Unlock",
                    type: "boolean",
                    role: "button.start",
                    read: false,
                    write: true,
                },
                native: {},
            });
        }
        if (device.hasCommand(CommandName.DeviceSetDefaultAngle)) {
            await this.setObjectNotExistsAsync(device.getStateID(IndoorCameraStateID.SET_DEFAULT_ANGLE), {
                type: "state",
                common: {
                    name: "Set Default Angle",
                    type: "boolean",
                    role: "button.start",
                    read: false,
                    write: true,
                },
                native: {},
            });
        }
        if (device.hasCommand(CommandName.DeviceSetPrivacyAngle)) {
            await this.setObjectNotExistsAsync(device.getStateID(IndoorCameraStateID.SET_PRIVACY_ANGLE), {
                type: "state",
                common: {
                    name: "Set Default Angle",
                    type: "boolean",
                    role: "button.start",
                    read: false,
                    write: true,
                },
                native: {},
            });
        }
        if (device.hasCommand(CommandName.DeviceCalibrate)) {
            await this.setObjectNotExistsAsync(device.getStateID(LockStateID.CALIBRATE), {
                type: "state",
                common: {
                    name: "Calibrate",
                    type: "boolean",
                    role: "button.start",
                    read: false,
                    write: true,
                },
                native: {},
            });
        }

        //TODO: Decomment as soon as the decryption of the images works
        /*if (device.hasProperty(PropertyName.DevicePictureUrl)) {
            // Last event picture
            const last_camera_url = device.getPropertyValue(PropertyName.DevicePictureUrl);
            if (last_camera_url !== undefined)
                saveImageStates(this, last_camera_url as string, device.getStationSerial(), device.getSerial(), DataLocation.LAST_EVENT, device.getStateID(CameraStateID.LAST_EVENT_PIC_URL), device.getStateID(CameraStateID.LAST_EVENT_PIC_HTML), "Last event picture").catch(() => {
                    this.logger.error(`State LAST_EVENT_PICTURE_URL of device ${device.getSerial()} - saveImageStates(): url ${last_camera_url}`);
                });
        }*/

        if (device.hasCommand(CommandName.DeviceStartLivestream)) {
            // Start Stream
            await this.setObjectNotExistsAsync(device.getStateID(CameraStateID.START_STREAM), {
                type: "state",
                common: {
                    name: "Start stream",
                    type: "boolean",
                    role: "button.start",
                    read: false,
                    write: true,
                },
                native: {},
            });

            // Stop Stream
            await this.setObjectNotExistsAsync(device.getStateID(CameraStateID.STOP_STREAM), {
                type: "state",
                common: {
                    name: "Stop stream",
                    type: "boolean",
                    role: "button.stop",
                    read: false,
                    write: true,
                },
                native: {},
            });

            // Livestream URL
            await this.setObjectNotExistsAsync(device.getStateID(CameraStateID.LIVESTREAM), {
                type: "state",
                common: {
                    name: "Livestream URL",
                    type: "string",
                    role: "url",
                    read: true,
                    write: false,
                },
                native: {},
            });

            // Last livestream video URL
            await this.setObjectNotExistsAsync(device.getStateID(CameraStateID.LAST_LIVESTREAM_VIDEO_URL), {
                type: "state",
                common: {
                    name: "Last livestream video URL",
                    type: "string",
                    role: "url",
                    read: true,
                    write: false,
                },
                native: {},
            });

            // Last livestream picture URL
            await this.setObjectNotExistsAsync(device.getStateID(CameraStateID.LAST_LIVESTREAM_PIC_URL), {
                type: "state",
                common: {
                    name: "Last livestream picture URL",
                    type: "string",
                    role: "url",
                    read: true,
                    write: false,
                },
                native: {},
            });

            // Last livestream picture HTML
            await this.setObjectNotExistsAsync(device.getStateID(CameraStateID.LAST_LIVESTREAM_PIC_HTML), {
                type: "state",
                common: {
                    name: "Last livestream picture HTML image",
                    type: "string",
                    role: "html",
                    read: true,
                    write: false,
                },
                native: {},
            });
        }

        if (device.hasProperty(PropertyName.DeviceRTSPStream)) {
            // RTSP Stream URL
            await this.setObjectNotExistsAsync(device.getStateID(CameraStateID.RTSP_STREAM_URL), {
                type: "state",
                common: {
                    name: "RTSP stream URL",
                    type: "string",
                    role: "url",
                    read: true,
                    write: false
                },
                native: {},
            });
        }

        if (device.hasCommand(CommandName.DeviceStartDownload)) {
            // Last event video URL
            await this.setObjectNotExistsAsync(device.getStateID(CameraStateID.LAST_EVENT_VIDEO_URL), {
                type: "state",
                common: {
                    name: "Last event video URL",
                    type: "string",
                    role: "url",
                    read: true,
                    write: false,
                    def: ""
                },
                native: {},
            });

            // Last event picture URL
            await this.setObjectNotExistsAsync(device.getStateID(CameraStateID.LAST_EVENT_PIC_URL), {
                type: "state",
                common: {
                    name: "Last event picture URL",
                    type: "string",
                    role: "url",
                    read: true,
                    write: false,
                    def: ""
                },
                native: {},
            });

            // Last event picture HTML image
            await this.setObjectNotExistsAsync(device.getStateID(CameraStateID.LAST_EVENT_PIC_HTML), {
                type: "state",
                common: {
                    name: "Last event picture HTML image",
                    type: "string",
                    role: "html",
                    read: true,
                    write: false,
                    def: ""
                },
                native: {},
            });
        }
    }

    private async onDeviceRemoved(device: Device): Promise<void> {
        this.delObjectAsync(device.getStateID("", 0), { recursive: true }).catch((error) => {
            this.logger.error(`Error deleting removed device`, error);
        });
    }

    private async onStationAdded(station: Station): Promise<void> {
        this.subscribeStates(`${station.getStateID("", 0)}.*`);

        await this.setObjectNotExistsAsync(station.getStateID("", 0), {
            type: "device",
            common: {
                name: station.getName()
            },
            native: {},
        });

        await this.setObjectNotExistsAsync(station.getStateID("", 1), {
            type: "channel",
            common: {
                name: station.getStateChannel()
            },
            native: {},
        });

        await this.setObjectNotExistsAsync(station.getStateID(StationStateID.CONNECTION), {
            type: "state",
            common: {
                name: "Connection",
                type: "boolean",
                role: "indicator.connection",
                read: true,
                write: false,
            },
            native: {},
        });
        await this.setStateAsync(station.getStateID(StationStateID.CONNECTION), { val: false, ack: true });

        const metadata = station.getPropertiesMetadata();
        for(const property of Object.values(metadata)) {
            this.createAndSetState(station, property);
        }

        // Reboot station
        if (station.hasCommand(CommandName.StationReboot)) {
            await this.setObjectNotExistsAsync(station.getStateID(StationStateID.REBOOT), {
                type: "state",
                common: {
                    name: "Reboot station",
                    type: "boolean",
                    role: "button.start",
                    read: false,
                    write: true,
                },
                native: {},
            });
        }
        // Alarm Sound
        if (station.hasCommand(CommandName.StationTriggerAlarmSound)) {
            await this.setObjectNotExistsAsync(station.getStateID(StationStateID.TRIGGER_ALARM_SOUND), {
                type: "state",
                common: {
                    name: "Trigger Alarm Sound",
                    type: "boolean",
                    role: "button.start",
                    read: false,
                    write: true,
                },
                native: {},
            });
            await this.setObjectNotExistsAsync(station.getStateID(StationStateID.RESET_ALARM_SOUND), {
                type: "state",
                common: {
                    name: "Reset Alarm Sound",
                    type: "boolean",
                    role: "button.start",
                    read: false,
                    write: true,
                },
                native: {},
            });
        }
    }

    private async onStationRemoved(station: Station): Promise<void> {
        this.delObjectAsync(station.getStateID("", 0), { recursive: true }).catch((error) => {
            this.logger.error(`Error deleting removed station`, error);
        });
    }

    private async downloadEventVideo(device: Device, event_time: number, full_path: string | undefined, cipher_id: number | undefined): Promise<void> {
        this.logger.debug(`Device: ${device.getSerial()} full_path: ${full_path} cipher_id: ${cipher_id}`);
        try {
            if (!isEmpty(full_path) && cipher_id !== undefined) {
                const station = await this.eufy.getStation(device.getStationSerial());

                if (station !== undefined) {
                    if (this.downloadEvent[device.getSerial()])
                        clearTimeout(this.downloadEvent[device.getSerial()]);

                    let videoLength = getVideoClipLength(device);
                    const time_passed = (new Date().getTime() - new Date(event_time).getTime()) / 1000;

                    if (time_passed >= videoLength)
                        videoLength = 1;
                    else
                        videoLength = videoLength - time_passed;

                    this.logger.info(`Downloading video event for device ${device.getSerial()} in ${videoLength} seconds...`);
                    this.downloadEvent[device.getSerial()] = setTimeout(async () => {
                        station.startDownload(device, full_path!, cipher_id);
                    }, videoLength * 1000);
                }
            }
        } catch (error) {
            this.logger.error(`Device: ${device.getSerial()} - Error`, error);
        }
    }

    private async handlePushNotification(message: PushMessage): Promise<void> {
        try {
            if (message.device_sn !== undefined) {
                const device: Device = await this.eufy.getDevice(message.device_sn);
                //TODO: Decomment as soon as the decryption of the images works
                /*if (!isEmpty(message.pic_url)) {
                    await saveImageStates(this, message.pic_url!, device.getStationSerial(), device.getSerial(), DataLocation.LAST_EVENT, device.getStateID(CameraStateID.LAST_EVENT_PIC_URL), device.getStateID(CameraStateID.LAST_EVENT_PIC_HTML), "Last captured picture").catch(() => {
                        this.logger.error(`Device ${device.getSerial()} - saveImageStates(): url ${message.pic_url}`);
                    });
                }*/
                if ((message.push_count === 1 || message.push_count === undefined) && (message.file_path !== undefined && message.file_path !== "" && message.cipher !== undefined))
                    if (this.config.autoDownloadVideo)
                        await this.downloadEventVideo(device, message.event_time, message.file_path, message.cipher);
            }
        } catch (error) {
            if (error instanceof DeviceNotFoundError) {
                //Do nothing
            } else {
                this.logger.error("Handling push notification - Error", error);
            }
        }
    }

    private async onConnect(): Promise<void> {
        await this.setObjectNotExistsAsync("info", {
            type: "channel",
            common: {
                name: "info"
            },
            native: {},
        });
        await this.setObjectNotExistsAsync("info.connection", {
            type: "state",
            common: {
                name: "Global connection",
                type: "boolean",
                role: "indicator.connection",
                read: true,
                write: false,
            },
            native: {},
        });
        await this.setStateAsync("info.connection", { val: true, ack: true });
    }

    private async onClose(): Promise<void> {
        await this.setObjectNotExistsAsync("info", {
            type: "channel",
            common: {
                name: "info"
            },
            native: {},
        });
        await this.setObjectNotExistsAsync("info.connection", {
            type: "state",
            common: {
                name: "Global connection",
                type: "boolean",
                role: "indicator.connection",
                read: true,
                write: false,
            },
            native: {},
        });
        await this.setStateAsync("info.connection", { val: false, ack: true });
    }

    public getPersistentData(): PersistentData {
        return this.persistentData;
    }

    private async onPushConnect(): Promise<void> {
        await this.setObjectNotExistsAsync("info", {
            type: "channel",
            common: {
                name: "info"
            },
            native: {},
        });
        await this.setObjectNotExistsAsync("info.push_connection", {
            type: "state",
            common: {
                name: "Push notification connection",
                type: "boolean",
                role: "indicator.connection",
                read: true,
                write: false,
            },
            native: {},
        });
        await this.setStateAsync("info.push_connection", { val: true, ack: true });
    }

    private async onPushClose(): Promise<void> {
        await this.setObjectNotExistsAsync("info", {
            type: "channel",
            common: {
                name: "info"
            },
            native: {},
        });
        await this.setObjectNotExistsAsync("info.push_connection", {
            type: "state",
            common: {
                name: "Push notification connection",
                type: "boolean",
                role: "indicator.connection",
                read: true,
                write: false,
            },
            native: {},
        });
        await this.setStateAsync("info.push_connection", { val: false, ack: true });
    }

    private async onMQTTConnect(): Promise<void> {
        await this.setObjectNotExistsAsync("info", {
            type: "channel",
            common: {
                name: "info"
            },
            native: {},
        });
        await this.setObjectNotExistsAsync("info.mqtt_connection", {
            type: "state",
            common: {
                name: "MQTT connection",
                type: "boolean",
                role: "indicator.connection",
                read: true,
                write: false,
            },
            native: {},
        });
        await this.setStateAsync("info.mqtt_connection", { val: true, ack: true });
    }

    private async onMQTTClose(): Promise<void> {
        await this.setObjectNotExistsAsync("info", {
            type: "channel",
            common: {
                name: "info"
            },
            native: {},
        });
        await this.setObjectNotExistsAsync("info.mqtt_connection", {
            type: "state",
            common: {
                name: "MQTT connection",
                type: "boolean",
                role: "indicator.connection",
                read: true,
                write: false,
            },
            native: {},
        });
        await this.setStateAsync("info.mqtt_connection", { val: false, ack: true });
    }

    private async onStationCommandResult(station: Station, result: CommandResult): Promise<void> {
        if (result.return_code !== 0 && result.command_type === CommandType.CMD_START_REALTIME_MEDIA) {
            this.logger.debug(`Station: ${station.getSerial()} command ${CommandType[result.command_type]} failed with error: ${ErrorCode[result.return_code]} (${result.return_code}) fallback to RTMP livestream...`);
            try {
                const device = await this.eufy.getStationDevice(station.getSerial(), result.channel);
                if (device.isCamera())
                    this.eufy.startCloudLivestream(device.getSerial());
            } catch (error) {
                this.logger.error(`Station: ${station.getSerial()} command ${CommandType[result.command_type]} RTMP fallback failed - Error ${error}`);
            }
        } else if (result.return_code !== 0 && result.command_type !== CommandType.P2P_QUERY_STATUS_IN_LOCK) {
            this.logger.error(`Station: ${station.getSerial()} command ${CommandType[result.command_type]} failed with error: ${ErrorCode[result.return_code]} (${result.return_code})`);
        }
    }

    private async onStationPropertyChanged(station: Station, name: string, value: PropertyValue): Promise<void> {
        const states = await this.getStatesAsync(`${station.getStateID("", 1)}.*`);
        for (const state in states) {
            const obj = await this.getObjectAsync(state);
            if (obj) {
                if (obj.native.name !== undefined && obj.native.name === name) {
                    await setStateChangedAsync(this, state, obj.common.type === "string" && typeof value === "object" ? JSON.stringify(value) : value);
                    return;
                }
            }
        }
        this.logger.debug(`onStationPropertyChanged(): Property "${name}" not implemented in this adapter (station: ${station.getSerial()} value: ${JSON.stringify(value)})`);
    }

    private async onDevicePropertyChanged(device: Device, name: string, value: PropertyValue): Promise<void> {
        const states = await this.getStatesAsync(`${device.getStateID("", 1)}.*`);
        for (const state in states) {
            const obj = await this.getObjectAsync(state);
            if (obj) {
                if (obj.native.name !== undefined && obj.native.name === name) {
                    await setStateChangedAsync(this, state, obj.common.type === "string" && typeof value === "object" ? JSON.stringify(value) : value);
                    switch(name) {
                        case PropertyName.DeviceRTSPStream:
                            if (value as boolean === false) {
                                this.delStateAsync(device.getStateID(CameraStateID.RTSP_STREAM_URL));
                            }
                            break;
                    }
                    return;
                }
            }
        }
        this.logger.debug(`onDevicePropertyChanged(): Property "${name}" not implemented in this adapter (device: ${device.getSerial()} value: ${JSON.stringify(value)})`);
    }

    private async startLivestream(device_sn: string): Promise<void> {
        try {
            const device = await this.eufy.getDevice(device_sn);
            const station = await this.eufy.getStation(device.getStationSerial());

            if (station.isConnected() || station.isEnergySavingDevice()) {
                if (!station.isLiveStreaming(device)) {
                    this.eufy.startStationLivestream(device_sn);
                } else {
                    this.logger.warn(`The stream for the device ${device_sn} cannot be started, because it is already streaming!`);
                }
            } else if (device.isCamera()) {
                const camera = device as Camera;
                if (!camera.isStreaming()) {
                    this.eufy.startCloudLivestream(device_sn);
                } else {
                    this.logger.warn(`The stream for the device ${device_sn} cannot be started, because it is already streaming!`);
                }
            }
        } catch (error) {
            this.logger.error("Start livestream - Error", error);
        }
    }

    private async stopLivestream(device_sn: string): Promise<void> {
        try {
            const device = await this.eufy.getDevice(device_sn);
            const station = await this.eufy.getStation(device.getStationSerial());
            if (device.isCamera()) {
                const camera = device as Camera;
                if (await this.eufy.isStationConnected(device.getStationSerial()) && station.isLiveStreaming(camera)) {
                    await this.eufy.stopStationLivestream(device_sn);
                } else if (camera.isStreaming()) {
                    await this.eufy.stopCloudLivestream(device_sn);
                } else {
                    this.logger.warn(`The stream for the device ${device_sn} cannot be stopped, because it isn't streaming!`);
                }
            }

        } catch (error) {
            this.logger.error("Stop livestream - Error", error);
        }
    }

    private async onCloudLivestreamStart(station: Station, device: Device, url: string): Promise<void> {
        this.setStateAsync(device.getStateID(CameraStateID.LIVESTREAM), { val: url, ack: true });

        const file_path = getDataFilePath(this, station.getSerial(), DataLocation.LIVESTREAM, `${device.getSerial()}${STREAM_FILE_NAME_EXT}`);
        await sleep(2000);
        const rtmpPromise: StoppablePromise = ffmpegRTMPToHls(this.config, url, file_path, this.logger);
        rtmpPromise.then(async () => {
            if (fse.pathExistsSync(file_path)) {
                await removeFiles(this, station.getSerial(), DataLocation.LAST_LIVESTREAM, device.getSerial());
                return true;
            }
            return false;
        })
            .then(async (result) => {
                if (result)
                    await moveFiles(this, station.getSerial(), device.getSerial(), DataLocation.LIVESTREAM, DataLocation.LAST_LIVESTREAM);
                return result;
            })
            .then(async (result) => {
                if (result) {
                    const filename_without_ext = getDataFilePath(this, station.getSerial(), DataLocation.LAST_LIVESTREAM, device.getSerial());
                    if (fse.pathExistsSync(`${filename_without_ext}${STREAM_FILE_NAME_EXT}`))
                        await ffmpegPreviewImage(this.config, `${filename_without_ext}${STREAM_FILE_NAME_EXT}`, `${filename_without_ext}${IMAGE_FILE_JPEG_EXT}`, this.logger, 5.5)
                            .then(() => {
                                this.setStateAsync(device.getStateID(CameraStateID.LAST_LIVESTREAM_PIC_URL), { val: `/${this.namespace}/${station.getSerial()}/${DataLocation.LAST_LIVESTREAM}/${device.getSerial()}${IMAGE_FILE_JPEG_EXT}`, ack: true });
                                try {
                                    if (fse.existsSync(`${filename_without_ext}${IMAGE_FILE_JPEG_EXT}`)) {
                                        this.setStateAsync(device.getStateID(CameraStateID.LAST_LIVESTREAM_PIC_HTML), { val: getImageAsHTML(fse.readFileSync(`${filename_without_ext}${IMAGE_FILE_JPEG_EXT}`)), ack: true });
                                    }
                                } catch (error) {
                                    this.logger.error(`Station: ${station.getSerial()} device: ${device.getSerial()} - Error`, error);
                                }
                            })
                            .catch((error) => {
                                this.logger.error(`ffmpegPreviewImage - station: ${station.getSerial()} device: ${device.getSerial()} - Error`, error);
                            });
                }
            })
            .catch(async (error) => {
                this.logger.error(`Station: ${station.getSerial()} device: ${device.getSerial()} - Error - Stopping livestream...`, error);
                await this.eufy.stopCloudLivestream(device.getSerial());
            });
        this.rtmpFFmpegPromise.set(device.getSerial(), rtmpPromise);
    }

    private onCloudLivestreamStop(station: Station, device: Device): void {
        this.logger.debug(`Station: ${station.getSerial()} device: ${device.getSerial()}`);
        this.delStateAsync(device.getStateID(CameraStateID.LIVESTREAM));

        const rtmpPromise = this.rtmpFFmpegPromise.get(device.getSerial());
        if (rtmpPromise) {
            rtmpPromise.stop();
            this.rtmpFFmpegPromise.delete(device.getSerial());
        }
    }

    private async onStationLivestreamStart(station: Station, device: Device, metadata: StreamMetadata, videostream: Readable, audiostream: Readable): Promise<void> {
        try {
            const file_path = getDataFilePath(this, station.getSerial(), DataLocation.LIVESTREAM, `${device.getSerial()}${STREAM_FILE_NAME_EXT}`);
            await removeFiles(this, station.getSerial(), DataLocation.LIVESTREAM, device.getSerial()).catch();
            this.setStateAsync(device.getStateID(CameraStateID.LIVESTREAM), { val: `/${this.namespace}/${station.getSerial()}/${DataLocation.LIVESTREAM}/${device.getSerial()}${STREAM_FILE_NAME_EXT}`, ack: true });
            await ffmpegStreamToHls(this.config, this.namespace, metadata, videostream, audiostream, file_path, this.logger)
                .then(async () => {
                    if (fse.pathExistsSync(file_path)) {
                        await removeFiles(this, station.getSerial(), DataLocation.LAST_LIVESTREAM, device.getSerial());
                        return true;
                    }
                    return false;
                })
                .then(async (result) => {
                    if (result)
                        await moveFiles(this, station.getSerial(), device.getSerial(), DataLocation.LIVESTREAM, DataLocation.LAST_LIVESTREAM);
                    return result;
                })
                .then(async (result) => {
                    if (result) {
                        const filename_without_ext = getDataFilePath(this, station.getSerial(), DataLocation.LAST_LIVESTREAM, device.getSerial());
                        this.setStateAsync(device.getStateID(CameraStateID.LAST_LIVESTREAM_VIDEO_URL), { val: `/${this.namespace}/${station.getSerial()}/${DataLocation.LAST_LIVESTREAM}/${device.getSerial()}${STREAM_FILE_NAME_EXT}`, ack: true });
                        if (fse.pathExistsSync(`${filename_without_ext}${STREAM_FILE_NAME_EXT}`))
                            await ffmpegPreviewImage(this.config, `${filename_without_ext}${STREAM_FILE_NAME_EXT}`, `${filename_without_ext}${IMAGE_FILE_JPEG_EXT}`, this.logger)
                                .then(() => {
                                    this.setStateAsync(device.getStateID(CameraStateID.LAST_LIVESTREAM_PIC_URL), { val: `/${this.namespace}/${station.getSerial()}/${DataLocation.LAST_LIVESTREAM}/${device.getSerial()}${IMAGE_FILE_JPEG_EXT}`, ack: true });
                                    try {
                                        if (fse.existsSync(`${filename_without_ext}${IMAGE_FILE_JPEG_EXT}`)) {
                                            this.setStateAsync(device.getStateID(CameraStateID.LAST_LIVESTREAM_PIC_HTML), { val: getImageAsHTML(fse.readFileSync(`${filename_without_ext}${IMAGE_FILE_JPEG_EXT}`)), ack: true });
                                        }
                                    } catch (error) {
                                        this.logger.error(`Station: ${station.getSerial()} device: ${device.getSerial()} - Error`, error);
                                    }
                                })
                                .catch((error) => {
                                    this.logger.error(`ffmpegPreviewImage - station: ${station.getSerial()} device: ${device.getSerial()} - Error`, error);
                                });
                    }
                })
                .catch(async (error) => {
                    this.logger.error(`Station: ${station.getSerial()} Device: ${device.getSerial()} - Error - Stopping livestream...`, error);
                    await this.eufy.stopStationLivestream(device.getSerial());
                });
        } catch(error) {
            this.logger.error(`Station: ${station.getSerial()} Device: ${device.getSerial()} - Error - Stopping livestream...`, error);
            await this.eufy.stopStationLivestream(device.getSerial());
        }
    }

    private onStationLivestreamStop(_station: Station, device: Device): void {
        this.delStateAsync(device.getStateID(CameraStateID.LIVESTREAM));
    }

    private async onStationDownloadFinish(_station: Station, _device: Device): Promise<void> {
        //this.logger.trace(`Station: ${station.getSerial()} channel: ${channel}`);
    }

    private async onStationDownloadStart(station: Station, device: Device, metadata: StreamMetadata, videostream: Readable, audiostream: Readable): Promise<void> {
        try {
            await removeFiles(this, station.getSerial(), DataLocation.TEMP, device.getSerial()).catch();
            const file_path = getDataFilePath(this, station.getSerial(), DataLocation.TEMP, `${device.getSerial()}${STREAM_FILE_NAME_EXT}`);

            await ffmpegStreamToHls(this.config, this.namespace, metadata, videostream, audiostream, file_path, this.logger)
                .then(async () => {
                    if (fse.pathExistsSync(file_path)) {
                        await removeFiles(this, station.getSerial(), DataLocation.LAST_EVENT, device.getSerial());
                        return true;
                    }
                    return false;
                })
                .then(async (result) => {
                    if (result)
                        await moveFiles(this, station.getSerial(), device.getSerial(), DataLocation.TEMP, DataLocation.LAST_EVENT);
                    return result;
                })
                .then(async (result) => {
                    if (result) {
                        const filename_without_ext = getDataFilePath(this, station.getSerial(), DataLocation.LAST_EVENT, device.getSerial());
                        setStateAsync(this, device.getStateID(CameraStateID.LAST_EVENT_VIDEO_URL), "Last captured video URL", `/${this.namespace}/${station.getSerial()}/${DataLocation.LAST_EVENT}/${device.getSerial()}${STREAM_FILE_NAME_EXT}`, "url");
                        if (fse.pathExistsSync(`${filename_without_ext}${STREAM_FILE_NAME_EXT}`))
                            await ffmpegPreviewImage(this.config, `${filename_without_ext}${STREAM_FILE_NAME_EXT}`, `${filename_without_ext}${IMAGE_FILE_JPEG_EXT}`, this.logger)
                                .then(() => {
                                    setStateAsync(this, device.getStateID(CameraStateID.LAST_EVENT_PIC_URL), "Last event picture URL", `/${this.namespace}/${station.getSerial()}/${DataLocation.LAST_EVENT}/${device.getSerial()}${IMAGE_FILE_JPEG_EXT}`, "url");
                                    try {
                                        if (fse.existsSync(`${filename_without_ext}${IMAGE_FILE_JPEG_EXT}`)) {
                                            const image_data = getImageAsHTML(fse.readFileSync(`${filename_without_ext}${IMAGE_FILE_JPEG_EXT}`));
                                            setStateAsync(this, device.getStateID(CameraStateID.LAST_EVENT_PIC_HTML), "Last event picture HTML image", image_data, "html");
                                        }
                                    } catch (error) {
                                        this.logger.error(`Station: ${station.getSerial()} device: ${device.getSerial()} - Error`, error);
                                    }
                                })
                                .catch((error) => {
                                    this.logger.error(`ffmpegPreviewImage - station: ${station.getSerial()} device: ${device.getSerial()} - Error`, error);
                                });
                    }
                })
                .catch(async (error) => {
                    this.logger.error(`Station: ${station.getSerial()} Device: ${device.getSerial()} - Error - Cancelling download...`, error);
                    await this.eufy.cancelStationDownload(device.getSerial());
                });
        } catch(error) {
            this.logger.error(`Station: ${station.getSerial()} Device: ${device.getSerial()} - Error - Cancelling download...`, error);
            await this.eufy.cancelStationDownload(device.getSerial());
        }
    }

    private onStationRTSPUrl(station: Station, device: Device, value: string): void {
        setStateChangedAsync(this, device.getStateID(CameraStateID.RTSP_STREAM_URL), value);
    }

    private async onStationConnect(station: Station): Promise<void> {
        await this.setObjectNotExistsAsync(station.getStateID(StationStateID.CONNECTION), {
            type: "state",
            common: {
                name: "Connection",
                type: "boolean",
                role: "indicator.connection",
                read: true,
                write: false,
            },
            native: {},
        });
        await this.setStateAsync(station.getStateID(StationStateID.CONNECTION), { val: true, ack: true });
    }

    private async onStationClose(station: Station): Promise<void> {
        await this.setObjectNotExistsAsync(station.getStateID(StationStateID.CONNECTION), {
            type: "state",
            common: {
                name: "Connection",
                type: "boolean",
                role: "indicator.connection",
                read: true,
                write: false,
            },
            native: {},
        });
        await this.setStateAsync(station.getStateID(StationStateID.CONNECTION), { val: false, ack: true });
    }

    private onTFARequest(): void {
        this.logger.warn(`Two factor authentication request received, please enter valid verification code in state ${this.namespace}.verify_code`);
        this.verify_code= true;
    }

    private onCaptchaRequest(captchaId: string, captcha: string): void {
        this.captchaId = captchaId;
        this.logger.warn(`Captcha authentication request received, please enter valid captcha in state ${this.namespace}.captcha`);
        this.logger.warn(`Captcha: <img src="${captcha}">`);
        this.setStateAsync("received_captcha_html", { val: `<img src="${captcha}">`, ack: true });
    }

}

if (module.parent) {
    // Export the constructor in compact mode
    module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new euSec(options);
} else {
    // otherwise start the instance directly
    (() => new euSec())();
}
