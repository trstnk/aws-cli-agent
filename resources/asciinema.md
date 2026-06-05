## Some asciinema commands:

```
# record with max. pauses of 4 seconds
asciinema rec -i 4 demo.cast

# play with 2x speed
asciinema play -s 2.0 demo.cast

# render an animated GIF
agg demo.cast demo.gif --speed 1.0 --font-size 20 --theme monokai

# scale down GIF
gifsicle -O3 --colors 64 demo.gif -o demo-small.gif
```
