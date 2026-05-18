/* extension.js
*
* This program is free software: you can redistribute it and / or modify
* it under the terms of the GNU General Public License as published by
* the Free Software Foundation, either version 3 of the License, or
* (at your option) any later version.
* This program is distributed in the hope that it will be useful,
* but WITHOUT ANY WARRANTY; without even the implied warranty of
* MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.See the
* GNU General Public License for more details.
* You should have received a copy of the GNU General Public License
* along with this program.If not, see http://www.gnu.org/licenses/.
* SPDX - License - Identifier: GPL - 3.0 - or - later
*
* /
/* exported init */

import GLib from 'gi://GLib'
import Gio from 'gi://Gio'
import Clutter from 'gi://Clutter'
import St from 'gi://St'
import Pango from 'gi://Pango'
import { panel } from 'resource:///org/gnome/shell/ui/main.js'
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js'
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js'
import {
  Extension,
  gettext as _
} from 'resource:///org/gnome/shell/extensions/extension.js'
import { EFIBootManager } from './efibootmgr.js'
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const ManagerInterface = `<node>
  <interface name="org.freedesktop.login1.Manager">
    <method name="Reboot">
      <arg type="b" direction="in"/>
    </method>
  </interface>
</node>`

const Manager = Gio.DBusProxy.makeProxyWrapper(ManagerInterface)

export default class RestartToWindowsExtension extends Extension {
  menu
  proxy
  RestartToWindowsItem
  /** @type {number} */
  counter
  /** @type {number} */
  counterIntervalId
  /** @type {number} */
  messageIntervalId
  sourceId

  _modifySystemItem () {
    this.menu =
      panel.statusArea.quickSettings._system?.quickSettingsItems[0].menu
    this.proxy = Manager(
      Gio.DBus.system,
      'org.freedesktop.login1',
      '/org/freedesktop/login1'
    )

    this.RestartToWindowsItem = new PopupMenu.PopupMenuItem(`${_('Restart to Windows')}...`)

    this.RestartToWindowsItem.connect('activate', () => {
      this.counter = 60 // Changed from 5 to 60 seconds

      const dialog = this._buildDialog()
      dialog.open()

      this.counterIntervalId = setInterval(() => {
        if (this.counter > 0) {
          this.counter--
        } else {
          this._clearIntervals()
          this._reboot()  // Changed from _Restart to _reboot
        }
      }, 1000)
    })

    this.menu.addMenuItem(this.RestartToWindowsItem, 2)
  }

  async _reboot () {  // Changed from _Restart to _reboot
    try {
      console.log('Starting reboot process...')
      const entryNum = await EFIBootManager.findWindowsBootManager()
      console.log(`Found Windows Boot Manager entry: ${entryNum}`)

      if (!entryNum) {
        throw new Error('Windows Boot Manager entry not found')
      }

      const success = await EFIBootManager.setNextBoot(entryNum)
      if (success) {
        console.log('Initiating reboot...')
        // Create new proxy for each reboot attempt
        const proxy = new Gio.DBusProxy.new_for_bus_sync(
          Gio.BusType.SYSTEM,
          Gio.DBusProxyFlags.NONE,
          null,
          'org.freedesktop.login1',
          '/org/freedesktop/login1',
          'org.freedesktop.login1.Manager',
          null
        );

        proxy.call_sync('Reboot', new GLib.Variant('(b)', [false]), 0, -1, null);
      } else {
        throw new Error('Failed to set next boot entry')
      }
    } catch (error) {
      console.error(`Error during reboot: ${error}`)
      Main.notifyError(_('Error'), _('Failed to restart to Windows'))
    }
  }

  _queueModifySystemItem () {
    this.sourceId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
      if (!panel.statusArea.quickSettings._system) return GLib.SOURCE_CONTINUE

      this._modifySystemItem()
      return GLib.SOURCE_REMOVE
    })
  }

  constructor (metadata) {
    super(metadata)
  }

  enable () {
    if (!panel.statusArea.quickSettings._system) {
      this._queueModifySystemItem()
    } else {
      this._modifySystemItem()
    }
  }

  disable () {
    this._clearIntervals()
    this.RestartToWindowsItem?.destroy()
    this.RestartToWindowsItem = null
    this.proxy = null
    if (this.sourceId) {
      GLib.Source.remove(this.sourceId)
      this.sourceId = null
    }
  }

  _buildDialog () {
    const dialog = new ModalDialog.ModalDialog({ styleClass: 'modal-dialog' })
    dialog.setButtons([
      {
        label: _('Cancel'),
        action: () => {
          this._clearIntervals()
          dialog.close()
        },
        key: Clutter.KEY_Escape,
        default: false
      },
      {
        label: _('Restart'),
        action: () => {
          this._clearIntervals()
          dialog.close()
          this._reboot()
        },
        default: false
      }
    ])

    const dialogTitle = new St.Label({
      text: _('Restart to Windows'),
      style: 'font-weight: bold;font-size:18px'
    })

    let dialogMessage = new St.Label({
      text: this._getDialogMessageText()
    })
    dialogMessage.clutter_text.ellipsize = Pango.EllipsizeMode.NONE
    dialogMessage.clutter_text.line_wrap = true

    const titleBox = new St.BoxLayout({
      x_align: Clutter.ActorAlign.CENTER
    })
    titleBox.add_child(new St.Label({ text: '  ' }))
    titleBox.add_child(dialogTitle)

    let box = new St.BoxLayout({ y_expand: true, vertical: true })
    box.add_child(titleBox)
    box.add_child(new St.Label({ text: '  ' }))
    box.add_child(dialogMessage)

    this.messageIntervalId = setInterval(() => {
      dialogMessage?.set_text(this._getDialogMessageText())
    }, 500)

    dialog.contentLayout.add_child(box)

    return dialog
  }

  _getDialogMessageText () {
    return _(`The system will restart to Windows in %d seconds.`).replace(
      '%d',
      this.counter
    )
  }

  _clearIntervals () {
    clearInterval(this.counterIntervalId)
    clearInterval(this.messageIntervalId)
  }
}

function _getWindowsTitle (grubConfig) {
  const lines = grubConfig.split('\n')

  const windowsLine = lines.find(line => line.toLowerCase().includes('windows'))

  if (!windowsLine) {
    return null
  }
  const match = windowsLine.match(/'([^']+)'/)
  return match ? match[1] : null
}

/**
 * Execute a command asynchronously and check the exit status.
 *
 * If given, @cancellable can be used to stop the process before it finishes.
 *
 * @param {string[]} argv - a list of string arguments
 * @param {Gio.Cancellable} [cancellable] - optional cancellable object
 * @returns {Promise<boolean>} - The process success
 */
async function execCheck (argv) {
  try {
    const proc = Gio.Subprocess.new(
      argv,
      Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
    )

    return new Promise((resolve, reject) => {
      proc.communicate_utf8_async(null, null, (proc, result) => {
        try {
          const [, stdout, stderr] = proc.communicate_utf8_finish(result)
          const status = proc.get_exit_status()

          if (status === 0) {
            console.log('Command executed successfully')
            resolve(true)
          } else {
            console.log(`Command failed: ${stderr}`)
            reject(new Error(`Command failed with status ${status}: ${stderr}`))
          }
        } catch (error) {
          reject(error)
        }
      })
    })
  } catch (error) {
    console.log(`Error executing command: ${error}`)
    throw error
  }
}
