// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const SYSTEMD_MANAGER = 'org.freedesktop.systemd1.Manager';
const SYSTEMD_PATH = '/org/freedesktop/systemd1';
const VARIANT_TUPLE_OF_VARIANT = GLib.VariantType.new('(v)');

const TRANSITIONAL_STATES = new Set([
    'initializing',
    'starting',
    'maintenance',
    'stopping',
]);

class SystemdMonitor {
    #connection;
    #proxy = null;
    #propertiesChangedId = null;
    #signalId = null;
    #unavailable = false;
    #onUpdate;

    constructor(connection, onUpdate) {
        this.#connection = connection;
        this.#onUpdate = onUpdate;
    }

    enable() {
        try {
            this.#proxy = Gio.DBusProxy.new_sync(
                this.#connection,
                Gio.DBusProxyFlags.GET_INVALIDATED_PROPERTIES,
                null,
                'org.freedesktop.systemd1',
                SYSTEMD_PATH,
                SYSTEMD_MANAGER,
                null,
            );

            this.#callMethod('Subscribe');

            this.#propertiesChangedId = this.#proxy.connect(
                'g-properties-changed',
                (dBusProxy, changedProperties) => {
                    // Systemd at least 253.3 doesn't emit PropertyChanged with SystemState
                    const properties = Object.keys(changedProperties.unpack());

                    if (!properties.includes('SystemState')) {
                        for (const property of ['NFailedUnits']) {
                            if (properties.includes(property)) {
                                dBusProxy.set_cached_property(
                                    'SystemState',
                                    this.#getProperty('SystemState').unpack(),
                                );
                            }
                        }
                    }

                    this.#onUpdate();
                },
            );

            this.#signalId = this.#proxy.connect(
                'g-signal',
                (_dBusProxy, _senderName, signalName) => {
                    if (!['JobRemoved', 'StartupFinished'].includes(signalName))
                        return;

                    this.#onUpdate();
                },
            );
        } catch {
            this.#unavailable = true;
            this.#proxy = null;
        }
    }

    disable() {
        if (this.#proxy) {
            try {
                this.#callMethod('Unsubscribe');
            } catch {
                // ignore errors during teardown
            }
        }

        if (this.#propertiesChangedId) {
            this.#proxy?.disconnect(this.#propertiesChangedId);
            this.#propertiesChangedId = null;
        }

        if (this.#signalId) {
            this.#proxy?.disconnect(this.#signalId);
            this.#signalId = null;
        }

        this.#proxy = null;
        this.#unavailable = false;
    }

    refreshSystemState() {
        if (!this.#proxy)
            return;

        this.#proxy.set_cached_property(
            'SystemState',
            this.#getProperty('SystemState').unpack(),
        );
    }

    getSnapshot() {
        if (this.#unavailable || !this.#proxy) {
            return {
                state: 'unavailable',
                failedUnits: [],
            };
        }

        const state = this.#proxy.get_cached_property('SystemState').unpack();
        const failedUnits = this.#callMethod(
            'ListUnitsFiltered',
            GLib.Variant.new_tuple([
                GLib.Variant.new_array(null, [GLib.Variant.new_string('failed')]),
            ]),
        ).get_child_value(0).deepUnpack().map(unit => unit[0]);

        return {state, failedUnits};
    }

    #getProperty(name) {
        return this.#connection.call_sync(
            this.#proxy.get_name(),
            this.#proxy.get_object_path(),
            'org.freedesktop.DBus.Properties',
            'Get',
            GLib.Variant.new_tuple([
                GLib.Variant.new_string(this.#proxy.get_interface_name()),
                GLib.Variant.new_string(name),
            ]),
            VARIANT_TUPLE_OF_VARIANT,
            Gio.DBusCallFlags.NONE,
            -1,
            null,
        ).get_child_value(0);
    }

    #callMethod(name, parameters = null) {
        return this.#proxy.call_sync(
            name,
            parameters,
            Gio.DBusCallFlags.NONE,
            -1,
            null,
        );
    }
}

const Indicator = GObject.registerClass(
class Indicator extends PanelMenu.Button {
    _init(metadata) {
        super._init(0.0, 'Systemd Status');

        this.metadata = metadata;

        this._greenIcon = this._getGIcon('systemd-green');
        this._yellowIcon = this._getGIcon('systemd-yellow');
        this._redIcon = this._getGIcon('systemd-red');

        this._icon = new St.Icon({gicon: this._greenIcon});
        this.add_child(this._icon);

        const section = new PopupMenu.PopupMenuSection();

        this._stateMenu = new St.Label();
        this._userStateMenu = new St.Label();
        this._statusMenu = new St.Label();

        this._stateMenu.add_style_class_name('padded');
        this._userStateMenu.add_style_class_name('padded');
        this._statusMenu.add_style_class_name('padded');

        section.actor.add_child(this._stateMenu);
        section.actor.add_child(this._userStateMenu);
        section.actor.add_child(this._statusMenu);

        this.menu.addMenuItem(section);
    }

    _getGIcon(name) {
        return Gio.icon_new_for_string(
            this.metadata.dir.get_child(`icons/${name}.svg`).get_path(),
        );
    }

    greenIcon() {
        this._icon.set_gicon(this._greenIcon);
    }

    yellowIcon() {
        this._icon.set_gicon(this._yellowIcon);
    }

    redIcon() {
        this._icon.set_gicon(this._redIcon);
    }

    setStatus(systemSnapshot, userSnapshot) {
        this._stateMenu.set_text(`Systemd state: ${systemSnapshot.state}`);
        this._userStateMenu.set_text(`Systemd user state: ${userSnapshot.state}`);

        const statusLines = [];

        if (systemSnapshot.failedUnits.length) {
            statusLines.push(
                `Failed units:\n • ${systemSnapshot.failedUnits.join('\n • ')}`,
            );
        }

        if (userSnapshot.failedUnits.length) {
            statusLines.push(
                `Failed user units:\n • ${userSnapshot.failedUnits.join('\n • ')}`,
            );
        }

        if (statusLines.length)
            this._statusMenu.set_text(statusLines.join('\n\n'));
        else
            this._statusMenu.set_text('All units are running');
    }
});

function isDegraded(snapshot) {
    return snapshot.state === 'degraded' || snapshot.failedUnits.length > 0;
}

function iconColorForSnapshots(systemSnapshot, userSnapshot) {
    if (isDegraded(systemSnapshot) || isDegraded(userSnapshot))
        return 'red';

    if (TRANSITIONAL_STATES.has(systemSnapshot.state) ||
        TRANSITIONAL_STATES.has(userSnapshot.state)) {
        return 'yellow';
    }

    if (systemSnapshot.state === 'running' && userSnapshot.state === 'running')
        return 'green';

    return 'red';
}

export default class SystemdStatusExtension extends Extension {
    constructor(metadata) {
        super(metadata);
        this._uuid = metadata['uuid'];
    }

    draw_systemd_state() {
        const systemSnapshot = this._systemMonitor.getSnapshot();
        const userSnapshot = this._userMonitor.getSnapshot();

        switch (iconColorForSnapshots(systemSnapshot, userSnapshot)) {
        case 'green':
            this._indicator.greenIcon();
            break;
        case 'yellow':
            this._indicator.yellowIcon();
            break;
        default:
            this._indicator.redIcon();
        }

        this._indicator.setStatus(systemSnapshot, userSnapshot);
    }

    enable() {
        this._indicator = new Indicator(this.metadata);
        Main.panel.addToStatusArea(this._uuid, this._indicator);

        this._systemMonitor = new SystemdMonitor(
            Gio.DBus.system,
            () => this.draw_systemd_state(),
        );
        this._userMonitor = new SystemdMonitor(
            Gio.DBus.session,
            () => this.draw_systemd_state(),
        );

        this._systemMonitor.enable();
        this._userMonitor.enable();

        this.draw_systemd_state();

        this._intervalId = setInterval(() => {
            this._systemMonitor.refreshSystemState();
            this._userMonitor.refreshSystemState();
            this.draw_systemd_state();
        }, 60 * 1000);
    }

    disable() {
        clearInterval(this._intervalId);
        this._intervalId = null;

        this._systemMonitor.disable();
        this._systemMonitor = null;

        this._userMonitor.disable();
        this._userMonitor = null;

        this._indicator.destroy();
        this._indicator = null;
    }
}
