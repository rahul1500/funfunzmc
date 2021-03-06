import config from '@root/api/utils/configLoader'
import Debug from 'debug'
import express from 'express'
import http from 'http'

const debug = Debug('funfunzmc:http-server')

export default function startServer(app: express.Application): void {
  const PORT = config().config.server.port
  /**
   * Create HTTP server.
   */
  const server = http.createServer(app)

  /**
   * Listen on provided port, on all network interfaces.
   */
  server.listen(PORT)
  server.on('error', onError)
  server.on('listening', onListening)

  /**
   * Event listener for HTTP server "error" event.
   */
  function onError(error: any) {
    if (error.syscall !== 'listen') {
      throw error
    }

    const bind = typeof PORT === 'string'
      ? 'Pipe ' + PORT
      : 'Port ' + PORT

    // handle specific listen errors with friendly messages
    switch (error.code) {
    case 'EACCES':
      debug(bind + ' requires elevated privileges')
      process.exit(1)
      break
    case 'EADDRINUSE':
      debug(bind + ' is already in use')
      process.exit(1)
      break
    default:
      throw error
    }
  }

  /**
   * Event listener for HTTP server "listening" event.
   */
  function onListening() {
    const addr = server.address()
    if (addr) {
      const bind = typeof addr === 'string'
        ? 'pipe ' + addr
        : 'port ' + addr.port
      debug('Listening on ' + bind)
    } else {
      debug('addr not set')
    }
  }
}
