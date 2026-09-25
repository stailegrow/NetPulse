# Оформление окна установщика .dmg для dmgbuild (без AppleScript и доступа к Finder).
# Запуск: dmgbuild -s scripts/dmg_settings.py -D app=.../NetPulse.app -D bg=.../background.png "NetPulse" out.dmg
import os.path

app = defines["app"]  # noqa: F821
app_name = os.path.basename(app)

format = "UDZO"
filesystem = "HFS+"
files = [app]
symlinks = {"Applications": "/Applications"}
hide_extensions = [app_name]

icon = os.path.join(app, "Contents", "Resources", "icon.icns")
# Рядом с background.png лежит background@2x.png — dmgbuild сам соберёт Retina-фон.
background = defines["bg"]  # noqa: F821

window_rect = ((200, 120), (660, 400))
default_view = "icon-view"
show_status_bar = False
show_tab_view = False
show_toolbar = False
show_pathbar = False
show_sidebar = False
include_icon_view_settings = True
arrange_by = None
label_pos = "bottom"
icon_size = 128
text_size = 13
icon_locations = {app_name: (180, 170), "Applications": (480, 170)}
