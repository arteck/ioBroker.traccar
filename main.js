'use strict';

const utils = require('@iobroker/adapter-core');
const axios = require('axios').default;
const WebSocket = require('ws');
const defObj = require('./lib/object_definitions').defObj;
const helpers = require('./lib/adapter_helpers');

const WS_HEARTBEAT_INTERVAL = 30000;
const WS_RESTART_TIMEOUT    = 10000;
const WS_RESTART_MAX_TIMEOUT = 300000;
const AXIOS_TIMEOUT          = 15000;
const DEFAULT_UPDATE_INTERVAL = 120;
const MIN_UPDATE_INTERVAL = 10;
const MAX_UPDATE_INTERVAL = 86400;

class Traccar extends utils.Adapter {
    /**
     * @param {Partial<utils.AdapterOptions>} [options]
     */
    constructor(options) {
        super({
            ...options,
            name: 'traccar',
        });

        // FIX: alle Zustände als Instanz-Properties – keine Modul-Globals mehr
        this.cookie          = null;
        this.ws              = null;
        this.devices         = [];
        this.positions       = [];
        this.geofences       = [];
        this.geofencesNow    = new Map();
        this.ping            = null;
        this.pingTimeout     = null;
        this.autoRestartTimeout = null;
        this.updateTimeout  = null;
        this.reconnectAttempts = 0;
        this.unloading      = false;

        this.on('ready',  this.onReady.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    // ─── Lifecycle ────────────────────────────────────────────────────────────

    async onReady() {
        this.setState('info.connection', false, true);

        this.log.debug(`Scheme:   ${this.config.traccarScheme}`);
        this.log.debug(`Server:   ${this.config.traccarIp}:${this.config.traccarPort}`);
        this.log.debug(`Username: ${this.config.traccarUsername}`);
        this.log.debug(`Password: ${this.config.traccarPassword ? '**********' : '(not set)'}`);

        if (!this.validateConfig()) {
            return;
        }

        try {
            await this.authUser();
            await this.getTraccarDataOverAPI();
            this.updateGeofenceCacheFromPositions(this.positions, true);
            await this.processData();
            await this.processPosition();
            this.initWebsocket();
            this.scheduleUpdate();
        } catch (error) {
            this.log.warn(`Server is offline or the address is incorrect: ${error.message}`);
            this.setState('info.connection', false, true);
            this.scheduleRestart();
        }

        // Non-blocking version check – does not delay adapter startup
        this.checkNewVersion();
    }

    async onUnload(callback) {
        this.unloading = true;
        try {
            // FIX: konsistent this.clearTimeout nutzen
            this.clearTimeout(this.ping);
            this.clearTimeout(this.pingTimeout);
            this.clearTimeout(this.autoRestartTimeout);
            this.clearTimeout(this.updateTimeout);
            this.clearTimeout(this.versionCheckInterval);
            this.closeWebsocket();
            this.setState('info.connection', false, true);
        } finally {
            callback();
        }
    }

    validateConfig() {
        const { traccarScheme, traccarIp, traccarPort } = this.config;
        if (!helpers.isValidServerConfig(traccarScheme, traccarIp, traccarPort)) {
            this.log.error('Invalid Traccar server configuration; check scheme, address and port.');
            return false;
        }
        return true;
    }

    getUpdateIntervalMs() {
        const interval = helpers.getUpdateIntervalMs(
            this.config.updateInterval,
            DEFAULT_UPDATE_INTERVAL,
            MIN_UPDATE_INTERVAL,
            MAX_UPDATE_INTERVAL,
        );
        if (interval === null) {
            this.log.warn(`Invalid update interval; using ${DEFAULT_UPDATE_INTERVAL} seconds.`);
            return DEFAULT_UPDATE_INTERVAL * 1000;
        }
        return interval;
    }

    getServerUrl() {
        const host = this.config.traccarIp.includes(':') && !this.config.traccarIp.startsWith('[')
            ? `[${this.config.traccarIp}]`
            : this.config.traccarIp;
        return `${this.config.traccarScheme}://${host}:${this.config.traccarPort}`;
    }

    scheduleUpdate() {
        this.clearTimeout(this.updateTimeout);
        if (this.unloading) {
            return;
        }
        this.updateTimeout = this.setTimeout(async () => {
            this.updateTimeout = null;
            if (this.unloading) {
                return;
            }
            try {
                await this.getTraccarDataOverAPI();
                if (this.unloading) {
                    return;
                }
                this.updateGeofenceCacheFromPositions(this.positions, true);
                await this.processData();
                await this.processPosition();
            } catch (error) {
                this.log.warn(`Scheduled Traccar update failed: ${error.message}`);
            } finally {
                this.scheduleUpdate();
            }
        }, this.getUpdateIntervalMs());
    }

    // ─── Auth & API ───────────────────────────────────────────────────────────

    /**
     * Authentifiziert den Nutzer und speichert das Session-Cookie.
     */
    async authUser() {
        const auth = `email=${encodeURIComponent(this.config.traccarUsername)}&password=${encodeURIComponent(this.config.traccarPassword)}`;
        const resp = await axios.post(
            `${this.getServerUrl()}/api/session`,
            auth,
            {
                headers: { 'content-type': 'application/x-www-form-urlencoded' },
                timeout: AXIOS_TIMEOUT,  // FIX: Timeout hinzugefügt
            },
        );

        if (resp?.headers?.['set-cookie']) {
            this.cookie = resp.headers['set-cookie'][0];
            this.log.debug('Auth successful, cookie received.');
        } else {
            throw new Error('Auth failed: no cookie in response.');
        }
    }

    /**
     * Lädt Geräte, Positionen und Geofences parallel via REST-API.
     *
     * FIX: Promise.all statt deprecated axios.all; Timeout ergänzt.
     */
    async getTraccarDataOverAPI() {
        const baseUrl     = `${this.getServerUrl()}/api`;
        const axiosOpts   = {
            auth: {
                username: this.config.traccarUsername,
                password: this.config.traccarPassword,
            },
            timeout: AXIOS_TIMEOUT,   // FIX: Timeout hinzugefügt
        };

        // FIX: Promise.all statt deprecated axios.all
        const [devResp, posResp, geoResp] = await Promise.all([
            axios.get(`${baseUrl}/devices`,   axiosOpts),
            axios.get(`${baseUrl}/positions`, axiosOpts),
            axios.get(`${baseUrl}/geofences`, axiosOpts),
        ]);

        this.devices   = devResp.data  ?? [];
        this.positions = posResp.data  ?? [];
        this.geofences = geoResp.data  ?? [];

        this.log.debug(`API loaded: ${this.devices.length} devices, ${this.positions.length} positions, ${this.geofences.length} geofences`);
    }

    /**
     * Ermittelt die aktuelle Traccar-Server-Version (via /api/server) und
     * vergleicht sie mit dem neuesten GitHub-Release.
     *
     * - Bei neuerer GitHub-Version: setState('info.newVersion', `<version>`, true)
     * - Bei gleicher Version:       setState('info.newVersion', '', true)
     * - Bei Fehlern:                Warn-Log, kein setState
     */
    async checkNewVersion() {
        try {
            const baseUrl = this.getServerUrl();

            // 1) Lokale Traccar-Server-Version abrufen
            let localVersion = null;
            try {
                const serverResp = await axios.get(`${baseUrl}/api/server`, {
                    auth: {
                        username: this.config.traccarUsername,
                        password: this.config.traccarPassword,
                    },
                    timeout: 30000,
                });
                // Traccar liefert z.B. { ..., version: "5.12" }
                if (serverResp.data && serverResp.data.version) {
                    localVersion = serverResp.data.version;
                    this.log.debug(`Traccar server version: ${localVersion}`);
                }
            } catch (err) {
                this.log.debug(`Could not fetch local Traccar server version: ${err.message}`);
            }

            // 2) Neueste GitHub-Release-Version abrufen
            let githubVersion = null;
            try {
                const ghResp = await axios.get(
                    'https://api.github.com/repos/traccar/traccar/releases/latest',
                    {
                        headers: { 'User-Agent': 'ioBroker.traccar' },
                        timeout: 30000,
                    },
                );
                // GitHub-Tag: z.B. "v5.12" oder "5.12"
                if (ghResp.data && ghResp.data.tag_name) {
                    githubVersion = ghResp.data.tag_name.replace(/^v/, '');
                    this.log.debug(`Latest GitHub version: ${githubVersion}`);
                }
            } catch (err) {
                this.log.warn(`Could not fetch GitHub releases: ${err.message}`);
            }

            // 3) Vergleichen
            if (!githubVersion) {
                // Kein GitHub-Ergebnis → nichts tun
                return;
            }

            if (!localVersion) {
                this.log.warn('Traccar server version is unknown; skipping the update comparison.');
                return;
            }

            if (this._isVersionNewer(githubVersion, localVersion)) {
                this.setState('info.newVersion', githubVersion, true);
                this.log.info(`New Traccar version available on GitHub: ${githubVersion} (installed: ${localVersion})`);
            } else {
                this.setState('info.newVersion', '', true);
                this.log.debug(`Traccar is up-to-date (installed: ${localVersion}, latest: ${githubVersion})`);
            }
        } catch (err) {
            this.log.warn(`Version check failed: ${err.message}`);
        } finally {
            // Nächsten Check in 24 Stunden einplanen
            if (!this.unloading) {
                this.versionCheckInterval = this.setTimeout(() => {
                    this.checkNewVersion();
                }, 86400000);
            }
        }
    }

    /**
     * Semver-ähnlicher Vergleich: Gibt true zurück wenn a > b.
     * Behandelt Strings wie "5.12", "5.12.0", "6.0" etc.
     *
     * @param {string} a
     * @param {string} b
     * @returns {boolean}
     */
    _isVersionNewer(a, b) {
        return helpers.isVersionNewer(a, b);
    }

    // ─── WebSocket ────────────────────────────────────────────────────────────

    initWebsocket() {
        const scheme = this.config.traccarScheme === 'http' ? 'ws' : 'wss';
        const url    = `${this.getServerUrl().replace(/^https?/, scheme)}/api/socket`;

        this.ws = new WebSocket(url, { headers: { Cookie: this.cookie } });

        this.ws.on('open', () => {
            this.log.info('Connected to Traccar server via WebSocket.');
            this.reconnectAttempts = 0;
            this.setState('info.connection', true, true);
            this.sendPingToServer();
            this.wsHeartbeat();
        });

        this.ws.on('message', async (message) => {
            this.log.debug(`Incoming message: ${message}`);
            try {
                const obj     = JSON.parse(message);
                const objName = Object.keys(obj)[0];

                if (objName === 'positions') {
                    // FIX: nur bei tatsächlicher Position-Nachricht leeren
                    this.positions = Array.isArray(obj.positions) ? obj.positions : [];
                    this.updateGeofenceCacheFromPositions(this.positions);
                    await this.processPosition();
                } else if (objName === 'devices') {
                    // FIX: for...of statt for...in über Array
                    for (const updatedDevice of obj.devices) {
                        const index = this.devices.findIndex((x) => x.id === updatedDevice.id);
                        if (index === -1) {
                            // Unbekanntes Gerät – API neu laden
                            await this.getTraccarDataOverAPI();
                            return;
                        }
                        this.devices[index] = updatedDevice;
                    }
                    await this.processData(false);
                }
            } catch (err) {
                this.log.error(`Error processing WebSocket message: ${err.message}`);
            }
        });

        this.ws.on('pong', () => {
            this.log.debug('Received pong from server.');
            this.wsHeartbeat();
        });

        this.ws.on('close', async () => {
            // FIX: this.clearTimeout konsistent verwenden
            this.clearTimeout(this.ping);
            this.clearTimeout(this.pingTimeout);
            this.setState('info.connection', false, true);
            this.log.warn('WebSocket disconnected.');

            if (this.ws.readyState === WebSocket.CLOSED) {
                this.scheduleRestart();
            }
        });

        // FIX: Fehlender Error-Handler – verhindert unkontrollierte Crashes
        this.ws.on('error', (err) => {
            this.log.error(`WebSocket error: ${err.message}`);
        });
    }

    sendPingToServer() {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            return;
        }
        this.log.debug('Sending ping to server.');
        this.ws.ping('iobroker.traccar');
        this.ping = this.setTimeout(() => {
            this.sendPingToServer();
        }, WS_HEARTBEAT_INTERVAL);
    }

    wsHeartbeat() {
        this.clearTimeout(this.pingTimeout);
        this.pingTimeout = this.setTimeout(() => {
            this.log.warn('WebSocket heartbeat timed out – terminating connection.');
            if (this.ws) {
this.ws.terminate();
}
        }, WS_HEARTBEAT_INTERVAL + 1000);
    }

    /**
     * FIX: scheduleRestart statt autoRestart – ruft NICHT mehr onReady() auf.
     * onReady() direkt aufzurufen führt zu gestapelten Event-Listenern (Memory Leak).
     * Stattdessen wird nur ein neuer Connect-Versuch gestartet.
     */
    scheduleRestart() {
        if (this.unloading || this.autoRestartTimeout) {
            return;
        }
        const delay = helpers.getReconnectDelay(this.reconnectAttempts, WS_RESTART_TIMEOUT, WS_RESTART_MAX_TIMEOUT);
        this.reconnectAttempts += 1;
        this.log.warn(`Reconnecting in ${delay / 1000} seconds...`);
        this.autoRestartTimeout = this.setTimeout(async () => {
            this.autoRestartTimeout = null;
            if (this.unloading) {
                return;
            }
            try {
                await this.authUser();
                await this.getTraccarDataOverAPI();
                if (this.unloading) {
                    return;
                }
                this.updateGeofenceCacheFromPositions(this.positions, true);
                await this.processData();
                await this.processPosition();
                this.initWebsocket();
            } catch (err) {
                this.log.warn(`Reconnect failed: ${err.message}`);
                this.scheduleRestart();
            }
        }, delay);
    }

    closeWebsocket() {
        if (this.ws && this.ws.readyState !== WebSocket.CLOSED) {
            this.ws.close();
        }
    }

    // ─── Datenverarbeitung ────────────────────────────────────────────────────

    async processData(cleanupStale = true) {
        if (!Array.isArray(this.devices)) {
            return;
        }

        await this.setObjectAndState('devices', 'devices');

        for (const device of this.devices) {
            const baseId = `devices.${device.id}`;

            await this.setObjectAndState('devices.device',                          baseId,                         device.name);
            await this.setObjectAndState('devices.device.device_name',              `${baseId}.device_name`,        null, device.name);
            await this.setObjectAndState('devices.device.status',                   `${baseId}.status`,             null, device.status);
            await this.setObjectAndState('devices.device.last_update_from_server',  `${baseId}.last_update_from_server`, null, device.lastUpdate);
            await this.setObjectAndState('devices.device.last_update',              `${baseId}.last_update`,        null, Number(Date.now()));

            // Traccar < v5.8: Geofences kommen vom Gerät
            if (device.geofenceIds) {
                const names = await this.getGeofencesState(device.geofenceIds);
                await this.setObjectAndState('devices.device.geofence_ids',    `${baseId}.geofence_ids`,    null, JSON.stringify(device.geofenceIds));
                await this.setObjectAndState('devices.device.geofences',       `${baseId}.geofences`,       null, JSON.stringify(names));
                await this.setObjectAndState('devices.device.geofences_string',`${baseId}.geofences_string`,null, names.join(', '));
            }
        }

        if (cleanupStale) {
            await this.removeStaleObjects('devices', this.devices.map(({ id }) => id));
        }
        await this.processGeofences(cleanupStale);
    }

    async processPosition(cleanupStale = false) {
        if (!Array.isArray(this.positions)) {
            return;
        }

        for (const position of this.positions) {
            const baseId = `devices.${position.deviceId}`;

            const altitude = this.parseFiniteNumber(position.altitude, 'altitude', position.deviceId);
            const accuracy = this.parseFiniteNumber(position.accuracy, 'accuracy', position.deviceId);
            const course = this.parseFiniteNumber(position.course, 'course', position.deviceId);
            const latitude = this.parseFiniteNumber(position.latitude, 'latitude', position.deviceId);
            const longitude = this.parseFiniteNumber(position.longitude, 'longitude', position.deviceId);
            const speed = this.parseFiniteNumber(position.speed, 'speed', position.deviceId);

            if (altitude !== null) {
                await this.setObjectAndState('devices.device.altitude', `${baseId}.altitude`, null, Number(altitude.toFixed(1)));
            }
            if (accuracy !== null) {
                await this.setObjectAndState('devices.device.accuracy', `${baseId}.accuracy`, null, Number(accuracy.toFixed(2)));
            }
            if (course !== null) {
                await this.setObjectAndState('devices.device.course', `${baseId}.course`, null, course);
            }
            if (latitude !== null && longitude !== null) {
                await this.setObjectAndState('devices.device.latitude', `${baseId}.latitude`, null, latitude);
                await this.setObjectAndState('devices.device.longitude', `${baseId}.longitude`, null, longitude);
                await this.setObjectAndState('devices.device.position', `${baseId}.position`, null, `${latitude},${longitude}`);
                await this.setObjectAndState('devices.device.position_url', `${baseId}.position_url`, null,
                    `https://maps.google.com/maps?z=15&t=m&q=loc:${latitude}+${longitude}`);
            }
            if (speed !== null) {
                await this.setObjectAndState('devices.device.speed', `${baseId}.speed`, null, Number(speed.toFixed()));
            }
            if (typeof position.outdated === 'boolean') {
                await this.setObjectAndState('devices.device.outdated', `${baseId}.outdated`, null, position.outdated);
            }
            await this.setObjectAndState('devices.device.last_update', `${baseId}.last_update`, null, Number(Date.now()));

            // Traccar >= v5.8: Geofences kommen von der Position
            if (Array.isArray(position.geofenceIds)) {
                const names = await this.getGeofencesState(position.geofenceIds);
                this.geofencesNow.set(String(position.deviceId), new Set(position.geofenceIds.map(String)));

                await this.setObjectAndState('devices.device.geofence_ids',     `${baseId}.geofence_ids`,     null, JSON.stringify(position.geofenceIds));
                await this.setObjectAndState('devices.device.geofences',        `${baseId}.geofences`,        null, JSON.stringify(names));
                await this.setObjectAndState('devices.device.geofences_string', `${baseId}.geofences_string`, null, names.join(', '));
            } else {
                this.geofencesNow.set(String(position.deviceId), new Set());
                await this.setObjectAndState('devices.device.geofence_ids',     `${baseId}.geofence_ids`,     null, '[]');
                await this.setObjectAndState('devices.device.geofences',        `${baseId}.geofences`,        null, '[]');
                await this.setObjectAndState('devices.device.geofences_string', `${baseId}.geofences_string`, null, '');
            }

            if (position.address) {
                await this.setObjectAndState('devices.device.address', `${baseId}.address`, null, position.address);
            }

            if (position.attributes && typeof position.attributes === 'object' && !Array.isArray(position.attributes)) {
                const usedAttributeNames = new Set();
                for (const key of Object.keys(position.attributes)) {
                    await this.createObjectAndState(position.deviceId, position.attributes, key, usedAttributeNames);
                }
            }
        }

        await this.processGeofences(cleanupStale);
    }

    async processGeofences(cleanupStale = true) {
        if (!Array.isArray(this.geofences)) {
            return;
        }

        await this.setObjectAndState('geofences', 'geofences');

        for (const geofence of this.geofences) {
            const baseId       = `geofences.${geofence.id}`;
            const geoDevState  = this.getGeoDeviceState(geofence, this.config.server58);

            await this.setObjectAndState('geofences.geofence',                baseId,                          geofence.name);
            await this.setObjectAndState('geofences.geofence.geofence_name',  `${baseId}.geofence_name`,  null, geofence.name);
            await this.setObjectAndState('geofences.geofence.device_ids',     `${baseId}.device_ids`,     null, JSON.stringify(geoDevState[0]));
            await this.setObjectAndState('geofences.geofence.devices',        `${baseId}.devices`,        null, JSON.stringify(geoDevState[1]));
            await this.setObjectAndState('geofences.geofence.devices_string', `${baseId}.devices_string`, null, geoDevState[1].join(', '));
            await this.setObjectAndState('geofences.geofence.occupation',     `${baseId}.occupation`,     null, geoDevState[0].length > 0);
            await this.setObjectAndState('geofences.geofence.last_update',    `${baseId}.last_update`,    null, Number(Date.now()));
        }
        if (cleanupStale) {
            await this.removeStaleObjects('geofences', this.geofences.map(({ id }) => id));
        }
    }

    // ─── Geofence-Hilfsmethoden ───────────────────────────────────────────────

    /**
     * Löst Geofence-IDs in Geofence-Namen auf.
     * FIX: API-Neuaufruf jetzt nur einmal, nicht pro fehlendem Eintrag im Loop.
     *
     * @param {number[]} geofenceIds
     * @returns {Promise<string[]>}
     */
    async getGeofencesState(geofenceIds) {
        if (!Array.isArray(geofenceIds) || !geofenceIds.length) {
            return [];
        }
        return helpers.resolveGeofenceNamesWithRetry(
            geofenceIds,
            this.geofences,
            async () => {
                await this.getTraccarDataOverAPI();
                return this.geofences;
            },
            (id) => this.log.warn(`Unknown geofence ID ${id}; using its ID as the name.`),
        );
    }

    updateGeofenceCacheFromPositions(positions, replace = false) {
        if (replace) {
            this.geofencesNow.clear();
        }
        for (const position of positions ?? []) {
            if (position?.deviceId === undefined || position?.deviceId === null) {
                continue;
            }
            this.geofencesNow.set(String(position.deviceId), new Set(
                Array.isArray(position.geofenceIds) ? position.geofenceIds.map(String) : [],
            ));
        }
    }

    parseFiniteNumber(value, field, deviceId) {
        const number = helpers.parseFiniteNumber(value);
        if (number === null && value !== null && value !== undefined && value !== '') {
            this.log.warn(`Ignoring invalid ${field} value for device ${deviceId}: ${value}`);
        }
        return number;
    }

    /**
     * Ermittelt welche Geräte sich gerade in einem Geofence befinden.
     * FIX: Null-Check für `found` ergänzt.
     *
     * @param {object} geofence
     * @param {boolean} serverVersion58
     * @returns {[number[], string[]]}
     */
    getGeoDeviceState(geofence, serverVersion58) {
        return helpers.getGeoDeviceState(geofence, serverVersion58, this.devices, this.geofencesNow);
    }

    async removeStaleObjects(collection, currentIds) {
        const prefix = `${this.namespace}.${collection}.`;
        const result = await this.getObjectListAsync({
            startkey: prefix,
            endkey: `${prefix}\u9999`,
        });
        const staleChannels = helpers.getStaleChannelIds(result.rows, prefix, currentIds);
        for (const id of staleChannels) {
            await this.delObjectAsync(id, { recursive: true });
            this.log.info(`Removed stale ${collection} object ${id}.`);
        }
    }

    // ─── Objekt/State-Verwaltung ──────────────────────────────────────────────

    async createObjectAndState(deviceId, obj, key, usedNames = new Set()) {
        const val   = obj[key];
        const baseObjId   = `devices.device`;
        const baseStateId = `devices.${deviceId}`;

        if (typeof val === 'object' && val !== null && !Array.isArray(val)) {
            for (const [objKey, objVal] of Object.entries(val)) {
                if (!helpers.claimAttributeName(objKey, usedNames)) {
                    this.log.warn(`Unsupported Traccar attribute name "${objKey}" – skipped.`);
                    continue;
                }
                await this.setObjectAndState(
                    `${baseObjId}.${this.formatName(objKey)}`,
                    `${baseStateId}.${this.formatName(objKey)}`,
                    this.formatStateName(objKey),
                    helpers.serializeAttributeValue(objVal),
                );
            }
        } else {
            if (!helpers.claimAttributeName(key, usedNames)) {
                this.log.warn(`Unsupported Traccar attribute name "${key}" – skipped.`);
                return;
            }
            await this.setObjectAndState(
                `${baseObjId}.${this.formatName(key)}`,
                `${baseStateId}.${this.formatName(key)}`,
                this.formatStateName(key),
                helpers.serializeAttributeValue(val),
            );
        }
    }

    /**
     * Erstellt ein Objekt (falls nicht vorhanden) und setzt den State-Wert.
     *
     * @param {string} objectId
     * @param {string} stateId
     * @param {string|null} stateName
     * @param {*} value
     */
    async setObjectAndState(objectId, stateId, stateName = null, value = null) {
        const template = defObj[objectId] ?? {
            type: 'state',
            common: {
                name:  stateName,
                type:  'mixed',
                role:  'state',
                read:  true,
                write: true,
            },
            native: {},
        };

        const common = { ...template.common };
        if (stateName !== null) {
            common.name = stateName;
        }

        await this.setObjectNotExistsAsync(stateId, {
            type:    template.type,
            common,
            native: { ...template.native },
        });

        if (value !== null) {
            await this.setStateChangedAsync(stateId, { val: value, ack: true });
        }
    }

    // ─── Formatierungshilfen ──────────────────────────────────────────────────

    /**
     * Wandelt camelCase in snake_case um.
     *
     * @param {string} input
     * @returns {string}
     */
    formatName(input) {
        return input.split(/(?=[A-Z])/).join('_').toLowerCase();
    }

    /**
     * Wandelt camelCase in einen lesbaren State-Namen um ("batteryLevel" → "Battery level").
     *
     * @param {string} input
     * @returns {string}
     */
    formatStateName(input) {
        const parts = input.split(/(?=[A-Z])/);
        return parts
            .map((part, i) => i === 0 ? part[0].toUpperCase() + part.slice(1) : part.toLowerCase())
            .join(' ');
    }
}

// FIX: module.parent ist deprecated seit Node 14 – require.main verwenden
if (require.main !== module) {
    const createAdapter = (options) => new Traccar(options);
    createAdapter.Traccar = Traccar;
    module.exports = createAdapter;
} else {
    new Traccar();
}
