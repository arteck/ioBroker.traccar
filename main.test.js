'use strict';

const { expect } = require('chai');
const helpers = require('./lib/adapter_helpers');

describe('Traccar adapter helpers', () => {
    it('matches geofence and device IDs exactly across number/string types', () => {
        const devices = [{ id: 1, name: 'First' }, { id: 11, name: 'Eleventh' }];
        const geofencesNow = new Map([['1', new Set(['11'])]]);

        expect(helpers.getGeoDeviceState({ id: 1 }, true, devices, geofencesNow)).to.deep.equal([[], []]);
        expect(helpers.getGeoDeviceState({ id: '11' }, true, devices, geofencesNow)).to.deep.equal([[1], ['First']]);
        expect(helpers.getGeoDeviceState({ id: '11' }, false, [{ ...devices[0], geofenceIds: [11] }], new Map()))
            .to.deep.equal([[1], ['First']]);
    });

    it('retries unknown geofence IDs once and leaves them identifiable', async () => {
        let reloads = 0;
        const names = await helpers.resolveGeofenceNamesWithRetry(
            [1, '99'],
            [{ id: '1', name: 'Home' }],
            async () => {
                reloads += 1;
                return [{ id: '1', name: 'Home' }];
            },
            () => {},
        );

        expect(names).to.deep.equal(['Home', 'Unknown geofence (99)']);
        expect(reloads).to.equal(1);
    });

    it('ignores missing and invalid numeric fields without producing NaN', () => {
        expect(helpers.parseFiniteNumber(null)).to.equal(null);
        expect(helpers.parseFiniteNumber('invalid')).to.equal(null);
        expect(helpers.parseFiniteNumber('12.5')).to.equal(12.5);
    });

    it('accepts safe dynamic attribute names and serializes structured values', () => {
        const usedNames = new Set();
        expect(helpers.isValidAttributeName('safeValue')).to.equal(true);
        expect(helpers.isValidAttributeName('bad.key')).to.equal(false);
        expect(helpers.isValidAttributeName('_private')).to.equal(false);
        expect(helpers.claimAttributeName('camelName', usedNames)).to.equal(true);
        expect(helpers.claimAttributeName('camel_name', usedNames)).to.equal(false);
        expect(helpers.serializeAttributeValue({ nested: true })).to.equal('{"nested":true}');
    });

    it('selects only stale direct channels for removal', () => {
        const rows = [
            { id: 'traccar.0.devices.1', value: { type: 'channel' } },
            { id: 'traccar.0.devices.2', value: { type: 'channel' } },
            { id: 'traccar.0.devices.2.latitude', value: { type: 'state' } },
            { id: 'traccar.0.devices.3', value: { type: 'state' } },
        ];

        expect(helpers.getStaleChannelIds(rows, 'traccar.0.devices.', [1])).to.deep.equal(['traccar.0.devices.2']);
    });

    it('falls back to a safe update interval for invalid settings', () => {
        expect(helpers.getUpdateIntervalMs(120, 120, 10, 86400)).to.equal(120000);
        expect(helpers.getUpdateIntervalMs(1, 120, 10, 86400)).to.equal(null);
        expect(helpers.getUpdateIntervalMs(undefined, 120, 10, 86400)).to.equal(120000);
        expect(helpers.isValidServerConfig('https', 'traccar.local', 443)).to.equal(true);
        expect(helpers.isValidServerConfig('https', 'traccar.local/path', 443)).to.equal(false);
        expect(helpers.isValidServerConfig('http', 'localhost', 70000)).to.equal(false);
    });

    it('applies a capped exponential reconnect delay', () => {
        expect(helpers.getReconnectDelay(0, 10000, 300000)).to.equal(10000);
        expect(helpers.getReconnectDelay(1, 10000, 300000)).to.equal(20000);
        expect(helpers.getReconnectDelay(8, 10000, 300000)).to.equal(300000);
    });

    it('compares numeric server versions and rejects unknown formats', () => {
        expect(helpers.isVersionNewer('6.10', '6.9')).to.equal(true);
        expect(helpers.isVersionNewer('6.0.0', '6')).to.equal(false);
        expect(helpers.isVersionNewer('unknown', '6.0')).to.equal(false);
    });

    it('selects geofence source from Traccar version and detects it from API data as fallback', () => {
        expect(helpers.getServerVersion58('5.7')).to.equal(false);
        expect(helpers.getServerVersion58('5.8')).to.equal(true);
        expect(helpers.getServerVersion58('6.0.1')).to.equal(true);
        expect(helpers.getServerVersion58('unknown')).to.equal(null);

        expect(helpers.detectServerVersion58([], [{ geofenceIds: [] }])).to.equal(true);
        expect(helpers.detectServerVersion58([{ geofenceIds: [] }], [])).to.equal(false);
        expect(helpers.detectServerVersion58([], [])).to.equal(null);
    });
});
