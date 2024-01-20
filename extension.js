// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const dbus = Gio.DBus.system;

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

        let section = new PopupMenu.PopupMenuSection();

        this._stateMenu = new St.Label();
        this._failedMenu = new St.Label();

        this._stateMenu.add_style_class_name('padded');
        this._failedMenu.add_style_class_name('padded');

        section.actor.add_actor(this._stateMenu);
        section.actor.add_actor(this._failedMenu);

        this.menu.addMenuItem(section);
    }

    _getGIcon(name) {
        return Gio.icon_new_for_string(
            this.metadata.dir.get_child(`icons/${name}.svg`).get_path()
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

    setState(state) {
        this._stateMenu.set_text(`Systemd state: ${state}`);
    }

    setFailed(failed) {
        if(failed.length) {
            this._failedMenu.set_text(`Failed units:\n • ${failed.join("\n • ")}`);
        }
        else {
            this._failedMenu.set_text("All units are running");
        }
    }
});

export default class SystemdStatusExtension extends Extension {
    #systemdInterface = 'org.freedesktop.systemd1.Manager';
    #variantTypeTupleOfVariant = GLib.VariantType.new('(v)')

    constructor(metadata) {
        super(metadata);
        this._uuid = metadata['uuid'];
    }

    draw_systemd_state() {
        let systemState = this._systemdProxy.get_cached_property('SystemState').unpack();
        let failedUnits = this.call_systemd_method(
            "ListUnitsFiltered",
            GLib.Variant.new_tuple([
                GLib.Variant.new_array(null, [GLib.Variant.new_string("failed")])
            ]),
        ).get_child_value(0).deepUnpack();

        switch(systemState) {
            case "initializing":
            case "starting":
            case "maintenance":
            case "stopping":
                this._indicator.yellowIcon();
                break;
            case "running":
                this._indicator.greenIcon();
                break;
            case "degraded":
            default:
                this._indicator.redIcon();
        }

        this._indicator.setState(systemState);
        this._indicator.setFailed(failedUnits.map((v => v[0])));
    }

    get_systemd_property(name) {
        return dbus.call_sync(
            this._systemdProxy.get_name(),
            this._systemdProxy.get_object_path(),
            "org.freedesktop.DBus.Properties",
            "Get",
            GLib.Variant.new_tuple([
                GLib.Variant.new_string(this._systemdProxy.get_interface_name()),
                GLib.Variant.new_string(name),
            ]),
            this.#variantTypeTupleOfVariant,
            Gio.DBusCallFlags.NONE,
            -1,
            null,
        ).get_child_value(0);
    }

    call_systemd_method(name, parameters = null) {
        return this._systemdProxy.call_sync(
            name,
            parameters,
            Gio.DBusCallFlags.NONE,
            -1,
            null,
        );
    }

    enable() {
        this._indicator = new Indicator(this.metadata);
        Main.panel.addToStatusArea(this._uuid, this._indicator);

        this._systemdProxy = Gio.DBusProxy.new_sync(
            dbus,
            Gio.DBusProxyFlags.GET_INVALIDATED_PROPERTIES,
            null,
            'org.freedesktop.systemd1',
            '/org/freedesktop/systemd1',
            this.#systemdInterface,
            null,
        );

        this.call_systemd_method('Subscribe');

        this._signalPropertiesChanged = this._systemdProxy.connect('g-properties-changed', (dBusProxy, changed_properties, invalidated_properties) => {
            // Systemd at least 253.3 doesn't emits PropertyChanged with SystemState
            let properties = Object.keys(changed_properties.unpack());
            if(!properties.includes('SystemState')) {
                for(let property of ['NFailedUnits']) {
                    if(properties.includes(property)) {
                        dBusProxy.set_cached_property(
                            'SystemState',
                            this.get_systemd_property('SystemState').unpack(),
                        );
                    }
                }
            }

            this.draw_systemd_state();
        });

        this._signalSignal = this._systemdProxy.connect('g-signal', (dBusProxy, sender_name, signal_name, parameters) => {
            if(!['JobRemoved', 'StartupFinished'].includes(signal_name)) {
                return;
            }

            this.draw_systemd_state();
        });

        this.draw_systemd_state();
    }

    disable() {
        this._indicator.destroy();
        this._indicator = null;

        this.call_systemd_method('Unsubscribe');

        if(this._signalPropertiesChanged) {
            this._systemdProxy.disconnect(this._signalPropertiesChanged);
            this._signalPropertiesChanged = null;
        }

        if(this._signalSignal) {
            this._systemdProxy.disconnect(this._signalSignal);
            this._signalSignal = null;
        }

        this._systemdProxy = null;
    }
}
