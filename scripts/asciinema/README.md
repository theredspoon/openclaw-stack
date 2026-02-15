# Asciinema Tools for Recording Screencasts

Example commands to resize and record claude sessions.

```bash
printf '\e[8;30;120t' && sleep 0.3 && asciinema rec -c "claude" demo.cast

# 16:9-ish, good for embedding on a blog or README
printf '\e[8;30;120t'

# Wider, good for showing code with longer lines
printf '\e[8;30;140t'

# Taller, good if Claude Code output is verbose
printf '\e[8;40;120t'

# Size in pixels
printf '\e[4;800;1200t'
```
