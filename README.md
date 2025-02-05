# RestartToWindows

A simple Linux application that allows you to restart your computer directly into Windows from your Linux desktop environment.

## Features

- One-click reboot to Windows
- Works directly with Windows Boot Manager
- Simple and lightweight GUI

## Requirements

- Linux system with dual-boot setup
- Windows installed as a secondary OS
- Administrative (sudo) privileges

## Download
You can clone the project from GitHub.
`$ git clone https://github.com/vedranbe/RestartToWindows`

## Usage

1. Launch the application
2. Click the "Restart to Windows" button
3. Enter your sudo password when prompted
4. Your system will restart and boot into Windows

## Building from Source

```bash
./build.sh  # Compiles translations and creates extension zip file
```

## Installation

1. Build the extension:
```bash
./build.sh
```
2. Install the extension:
```bash
./install.sh
```
3. Log out and log back in, or restart the GNOME Shell (Alt+F2, type 'r', press Enter)

Note: To disable the extension, you can use:
```bash
gnome-extensions disable RestartToWindows@vedranbe.github.com
```

## License

This project is licensed under the MIT License - see the LICENSE file for details.
