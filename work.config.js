export default {
  project: "herdr-terminal",
  commands: {
    web: {
      run: "bun dev",
      autoStart: true,
      portless: false,
    },
    production: {
      run: "bun start",
      portless: false,
    },
    tunnel: {
      run: "cloudflared tunnel --config ~/.cloudflared/herdr-terminal.yml run herdr-terminal",
      portless: false,
    },
  },
};
