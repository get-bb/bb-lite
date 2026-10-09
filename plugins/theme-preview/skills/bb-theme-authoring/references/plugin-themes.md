## Shipping a theme in a plugin

A plugin contributes themes through its manifest:

```json
"bb": {
  "themes": [
    { "id": "mine", "name": "Mine", "css": "./themes/mine.css", "codeTheme": { "dark": "nord" } }
  ]
}
```

bb lists it as `plugin:<pluginId>:mine`. `codeTheme` names syntax themes bb
already has, not files. Theme Preview reads the CSS through the manifest, so
swatches and live reload work the same way for every plugin. Load the plugin
with `bb plugin add <dir>`; run `bb plugin reload <pluginId>` after changing
the manifest. Saving the CSS of the active theme needs no reload while Theme
Preview is open.
