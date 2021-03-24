'use strict';

/*
 * Created with @iobroker/create-adapter v1.27.0
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require('@iobroker/adapter-core');

// Load your modules here, e.g.:
const axios = require('axios').default;
const WebSocket = require('ws');
const defObj = require('./lib/object_definitions').defObj;

let cookie;
let ws;
let devices;
let positions;
let geofences;
let ping;
let pingTimeout;
let autoRestartTimeout;
const wsHeartbeatIntervall = 30000;
const restartTimeout = 10000;

class Traccar extends utils.Adapter {

    /**
     * @param {Partial<utils.AdapterOptions>} [options={}]
     */
    constructor(options) {
        super({
            ...options,
            name: 'traccar',
        });

        this.on('ready', this.onReady.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    async onReady() {
        // Reset adapter connection
        this.setState('info.connection', false, true);

        // Log configuration
        this.log.debug('Server IP: ' + this.config.traccarIp);
        this.log.debug('Port: ' + this.config.traccarPort);
        this.log.debug('Username: ' + this.config.traccarUsername);
        this.log.debug('Password: ' + (this.config.traccarPassword !== '' ? '**********' : 'no password configured'));
        //this.log.debug('Update interval: ' + this.config.updateInterval);

        // Adapter is up and running
        this.log.debug('Adapter is up and running');
        // Get autuh cookie for websocket
        try {
            await this.authUser();
            // Get initial traccar data over HTTP-API
            await this.getTraccarDataOverAPI();
            // Connect websocket
            this.initWebsocket();
        } catch (error) {
            this.log.debug(error);
            this.log.warn('Server is offline or the address is incorrect!');
            this.autoRestart();
            this.setState('info.connection', false, true);
        }

    }

    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     * @param {() => void} callback
     */
    async onUnload(callback) {
        try {
            this.clearTimeout(ping);
            this.clearTimeout(pingTimeout);
            this.clearTimeout(autoRestartTimeout);
            // Reset adapter connection
            this.setState('info.connection', false, true);
            callback();
        } catch (e) {
            callback();
        }
    }

    /**
     * Is called to update Traccar data
     */
    async authUser() {
        const auth = `email=${encodeURIComponent(this.config.traccarUsername)}&password=${encodeURIComponent(this.config.traccarPassword)}`;
        const axiosOptions = {
            headers: {
                'content-type': 'application/x-www-form-urlencoded'
            }
        };
        // Get Cookie
        const resp = await axios.post(`http://${this.config.traccarIp}:${this.config.traccarPort}/api/session`, auth, axiosOptions);
        cookie = resp.headers['set-cookie'][0];

        this.log.debug('Auth succses, cookie: ' + cookie);
    }

    async initWebsocket(){
        // Set websocket connection
        ws = new WebSocket(`ws://${this.config.traccarIp}:${this.config.traccarPort}/api/socket`,{ headers: {Cookie: cookie} });

        // On connect
        ws.on('open', ()=>{
            this.log.debug('Websocket connectet');
            // Set connection state
            this.setState('info.connection', true, true);
            this.log.info('Connect to server over websocket connection.');
            // Send ping to server
            this.sendPingToServer();
            // Start Heartbeat
            this.wsHeartbeat();
        });

        // Incomming messages
        ws.on('message', async (message)=> {
            this.log.debug(`Incomming message: ${message}`);
            const obj = JSON.parse(message);
            const objName = Object.keys(obj)[0];

            // Position message
            if (objName == 'positions') {
                positions = obj.positions;
            }
            // Device message
            else if (objName == 'devices'){
                for (const key in obj.devices){
                    const index =  devices.findIndex(x => x.id == obj.devices[key].id);
                    if (index == -1){
                        await this.getTraccarDataOverAPI();
                        return;
                    }
                    devices[index] = obj.devices[key];
                }
            }
            // Process new data
            this.processData();
        });

        // On Close
        ws.on('close', ()=>{
            this.setState('info.connection', false, true);
            this.log.warn('Websocket disconnectet');
            clearTimeout(ping);
            clearTimeout(pingTimeout);

            if (ws.readyState === WebSocket.CLOSED) {
                this.autoRestart();
            }
        });

        // Pong from Server
        ws.on('pong', ()=> {
            this.log.debug('Receive pong from server');
            this.wsHeartbeat();
        });
    }

    async sendPingToServer(){
        this.log.debug('Send ping to server');
        ws.ping('iobroker.traccar');
        ping = setTimeout(() => {
            this.sendPingToServer();
        }, wsHeartbeatIntervall);
    }

    async wsHeartbeat() {
        clearTimeout(pingTimeout);
        pingTimeout = setTimeout(() => {
            this.log.debug('Websocked connection timed out');
            ws.terminate();
        }, wsHeartbeatIntervall + 1000);
    }

    async autoRestart(){
        this.log.warn(`Start try again in ${restartTimeout / 1000} seconds...`);
        autoRestartTimeout = setTimeout(() => {
            this.onReady();
        }, restartTimeout);
    }

    async processData() {
        // Process devices
        this.setObjectAndState('devices', 'devices');
        for (const device of devices) {
            const position = positions.find(p => p.id === device.positionId);
            const stateBaseID = `devices.${device.id}`;
            // Create static datapoins
            this.setObjectAndState('devices.device', stateBaseID, device.name);
            this.setObjectAndState('devices.device.device_name', `${stateBaseID}.device_name`, null, device.name);
            this.setObjectAndState('devices.device.last_update', `${stateBaseID}.last_update`, null, device.lastUpdate);
            this.setObjectAndState('devices.device.geofence_ids', `${stateBaseID}.geofence_ids`, null, JSON.stringify(device.geofenceIds));
            this.setObjectAndState('devices.device.geofences', `${stateBaseID}.geofences`, null, JSON.stringify(this.getGeofencesState(device)));
            this.setObjectAndState('devices.device.geofences_string', `${stateBaseID}.geofences_string`, null, this.getGeofencesState(device).join(', '));

            // Check if a position was found
            if (position){
                // Create static datapoins
                this.setObjectAndState('devices.device.altitude', `${stateBaseID}.altitude`, null, Number.parseFloat(position.altitude).toFixed(1));
                this.setObjectAndState('devices.device.course', `${stateBaseID}.course`, null, position.course);
                this.setObjectAndState('devices.device.latitude', `${stateBaseID}.latitude`, null, position.latitude);
                this.setObjectAndState('devices.device.longitude', `${stateBaseID}.longitude`, null, position.longitude);
                this.setObjectAndState('devices.device.position', `${stateBaseID}.position`, null, `${position.latitude},${position.longitude}`);
                this.setObjectAndState('devices.device.position_url', `${stateBaseID}.position_url`, null, `https://maps.google.com/maps?z=15&t=m&q=loc:${position.latitude}+${position.longitude}`);
                this.setObjectAndState('devices.device.speed', `${stateBaseID}.speed`, null, Number(position.speed).toFixed());
                // Address is optional
                if (position.address){
                    this.setObjectAndState('devices.device.address', `${stateBaseID}.address`, null, position.address);
                }

                // Create dynamic datapoints for attributes
                this.log.debug('============= Process attributes start ================');
                for (const key in position.attributes) {
                    await this.createObjectAndState(device, position.attributes, key);
                }
                this.log.debug('============== Process attributes end =================');
            }
        }

        // Process geofences
        this.setObjectAndState('geofences', 'geofences');
        for (const geofence of geofences) {
            const stateBaseID = `geofences.${geofence.id}`;
            // Create static datapoins
            const geoDeviceState = this.getGeoDeviceState(geofence);
            this.setObjectAndState('geofences.geofence', stateBaseID, geofence.name);
            this.setObjectAndState('geofences.geofence.geofence_name', `${stateBaseID}.geofence_name`, null, geofence.name);
            this.setObjectAndState('geofences.geofence.device_ids', `${stateBaseID}.device_ids`, null, JSON.stringify(geoDeviceState[0]));
            this.setObjectAndState('geofences.geofence.devices', `${stateBaseID}.devices`, null, JSON.stringify(geoDeviceState[1]));
            this.setObjectAndState('geofences.geofence.devices_string', `${stateBaseID}.devices_string`, null, geoDeviceState[1].join(', '));
        }
    }

    /**
     * Is called to update Traccar data
     */
    async getTraccarDataOverAPI() {
        const baseUrl = `http://${this.config.traccarIp}:${this.config.traccarPort}/api`;

        const axiosOptions = {
            auth: {
                username: this.config.traccarUsername,
                password: this.config.traccarPassword
            }
        };

        const responses = await axios.all([
            axios.get(`${baseUrl}/devices`, axiosOptions),
            axios.get(`${baseUrl}/positions`, axiosOptions),
            axios.get(`${baseUrl}/geofences`, axiosOptions)
        ]);

        for (const key in responses) {
            this.log.debug(JSON.stringify(responses[key].data));
        }

        devices = responses[0].data;
        positions = responses[1].data;
        geofences = responses[2].data;

        this.processData();
    }

    async getGeofencesState(device){
        const geofencesState = [];
        for (const geofenceId of device.geofenceIds) {
            const geofence = geofences.find(element => element.id === geofenceId);
            // Workaround for unclean geofences in the database
            if (!geofence && !geofence.name){
                await this.getTraccarDataOverAPI();
            }
            else{
                geofencesState.push(geofence.name);
            }
        }
        return geofencesState;
    }

    getGeoDeviceState(geofence){
        const deviceIdsState = [];
        const devicesState = [];
        for (const device of devices) {
            if (device.geofenceIds.includes(geofence.id)) {
                deviceIdsState.push(device.id);
                devicesState.push(device.name);
            }
        }
        return [deviceIdsState, devicesState];
    }

    async createObjectAndState(device, obj,  key){
        let val = obj[key];
        if (typeof val === 'object' && !Array.isArray(val)){
            for (const objKey in val) {
                const objVal = val[objKey];
                const stateID  = `devices.${device.id}.${this.formatName(objKey)}`;
                const objID = `devices.device.${this.formatName(objKey)}`;
                this.log.debug(`objID: ${objID}, val: ${objVal}`);
                this.setObjectAndState(objID, stateID, this.formatStateName(objKey), objVal);
            }
        }
        else{
            const stateID  = `devices.${device.id}.${this.formatName(key)}`;
            const objID = `devices.device.${this.formatName(key)}`;
            this.log.debug(`objID: ${objID}, val: ${val}`);
            if (Array.isArray(val)){
                val = JSON.stringify(val);
            }
            this.setObjectAndState(objID, stateID, this.formatStateName(key), val);
        }
    }
    /**
     * Is used to create and object and set the value
     * @param {string} objectId
     * @param {string} stateId
     * @param {string | null} stateName
     * @param {*} value
     */
    async setObjectAndState(objectId, stateId, stateName = null, value = null) {
        let obj;

        if (defObj[objectId]) {
            obj = defObj[objectId];
        }
        else {
            obj = {
                type: 'state',
                common: {
                    name: stateName,
                    type: 'mixed',
                    role: 'state',
                    read: true,
                    write: true
                },
                native: {}
            };
        }

        if (stateName !== null) {
            obj.common.name = stateName;
        }

        await this.setObjectNotExistsAsync(stateId, {
            type: obj.type,
            common: JSON.parse(JSON.stringify(obj.common)),
            native: JSON.parse(JSON.stringify(obj.native))
        });

        if (value !== null) {
            await this.setStateChangedAsync(stateId, {
                val: value,
                ack: true
            });
        }
    }

    formatName(input){
        const wordArray = input.split(/(?=[A-Z])/);
        return wordArray.join('_').toLowerCase();
    }

    formatStateName(input){
        const wordArray = input.split(/(?=[A-Z])/);
        for (const key in wordArray) {
            if (key === '0'){
                wordArray[key] = wordArray[key][0].toUpperCase() + wordArray[key].substr(1);
            }
            else{
                wordArray[key] = wordArray[key].toLowerCase();
            }
        }
        return wordArray.join(' ');
    }
}

// @ts-ignore parent is a valid property on module
if (module.parent) {
    // Export the constructor in compact mode
    /**
     * @param {Partial<utils.AdapterOptions>} [options={}]
     */
    module.exports = (options) => new Traccar(options);
} else {
    // otherwise start the instance directly
    new Traccar();
}
