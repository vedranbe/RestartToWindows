#!/bin/bash

# First compile translations
cd po || exit 1

# Get all .po files in directory
for pofile in *.po; do
    # Skip if no .po files found
    [[ -f "$pofile" ]] || continue

    # Extract language code from filename (remove .po extension)
    lang="${pofile%.po}"

    # Check if source .po file is not empty
    if [ ! -s "${pofile}" ]; then
        echo "Warning: ${pofile} is empty, skipping..."
        continue
    fi

    target_dir="../src/locale/${lang}/LC_MESSAGES"
    target_file="${target_dir}/RestartToWindows@vedranbe.github.com.mo"
    mkdir -p "${target_dir}"

    if msgfmt -v "${pofile}" -o "${target_file}"; then
        echo "Successfully compiled ${pofile}"
    else
        echo "Error: Failed to compile ${pofile}"
        exit 1
    fi
done

cd ..

EXTENSION_NAME="RestartToWindows@vedranbe.github.com"
SRC_DIR="src"
DIST_DIR="dist"

# Cleanup old build
rm -rf $DIST_DIR
mkdir -p $DIST_DIR

# Copy source files
cp -r $SRC_DIR/* $DIST_DIR/
cp metadata.json $DIST_DIR/

# Compile schemas
if [ -d "$SRC_DIR/schemas" ]; then
    mkdir -p $DIST_DIR/schemas
    glib-compile-schemas $DIST_DIR/schemas/
fi

# Zip for distribution
cd $DIST_DIR
zip -r ../$EXTENSION_NAME.zip ./*
cd ..

echo "✅ Build completed! Extension is in '$DIST_DIR' and '$EXTENSION_NAME.zip'."
