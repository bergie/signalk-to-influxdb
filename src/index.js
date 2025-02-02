/*
 * Copyright 2016 Teppo Kurki <teppo.kurki@iki.fi>
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

const { deltaToPointsConverter, influxClientP, pruneTimestamps } = require('./skToInflux')

import {registerHistoryApiRoute} from './HistoryAPI'

module.exports = function (app) {
  const logError = app.error || ((err) => {console.error(err)})
  let clientP
  let selfContext = 'vessels.' + app.selfId

  let started = false
  let unsubscribes = []
  let shouldStore = function (path) {
    return true
  }

  function toMultilineString (influxResult) {
    let currentLine = []
    const result = {
      type: 'MultiLineString',
      coordinates: []
    }

    influxResult.forEach(row => {
      if (row.position === null && row.jsonPosition == null ) {
        currentLine = []
      } else {
        let position
        if ( row.position ) {
          position = JSON.parse(row.position)
        } else {
          position = JSON.parse(row.jsonPosition)
          position = [ position.longitude, position.latitude ]
        }
        
        currentLine[currentLine.length] = position
        if (currentLine.length === 1) {
          result.coordinates[result.coordinates.length] = currentLine
        }
      }
    })
    return result
  }
  function timewindowStart () {
    return new Date(new Date().getTime() - 60 * 60 * 1000).toISOString()
  }
  function getContextClause(pathElements) {
    let skPath = null
    let contextClause = ''

    if ( pathElements != null ) {
      if ( pathElements.length == 1 ) {
        contextClause = `and context =~ /${pathElements[0]}.*/`
      } else if ( pathElements.length > 1 ) {
        let context = pathElements[1]
        if ( context == 'self' ) {
          context = app.selfId
        }
        contextClause = `and context =~ /${pathElements[0]}\.${context}\.*/`
      }
      
      skPath = pathElements.slice(2).join('.')
      if ( skPath.length === 0 ) {
        skPath = null
      }
    }
    return { skPath, contextClause }
  }

  function getQuery(startTime, endTime, pathElements) {
    const { skPath, contextClause } = getContextClause(pathElements)

    const measurements = skPath ? `/${skPath}.*/` : '/.*/'
    const whereClause = `time > '${startTime.toISOString()}' and time <= '${endTime.toISOString()}' ${contextClause}`
    const query = `${measurements}
        where ${whereClause} group by context order by time desc limit 1`
    return {query: query, skPath: skPath, whereClause:whereClause}
  }

  function getHistory (startTime, endTime, pathElements, cb) {
    const { query, skPath, whereClause } = getQuery(startTime, endTime, pathElements)
    app.debug('history query: %s', query)
    clientP.then(client => {
      client.query(`select * from ${query}`)
        .then(result => {
          let attitude = {}

          let deltas = result.groupRows.map(row => {
            let path = row.name
            let value = row.rows[0].value
            const {source, stringValue, jsonValue, boolValue} = row.rows[0]
            let context

            if ( row.tags && row.tags.context ) {
              context = row.tags.context
            } else {
              context = 'vessels.' + app.selfId
            }

            let ts = row.rows[0].time.toISOString()

            if ( path.startsWith('navigation.attitude') ) {
              let parts = path.split('.')
              attitude[parts[parts.length-1]] = value
              attitude.timestamp = ts
              attitude.$source = source
              attitude.context = context
              return null
            } else {
              if ( jsonValue != null ) {
                value = JSON.parse(jsonValue)
              } else if ( stringValue != null ) {
                value = stringValue
              } else if ( boolValue != null ) {
                value = boolValue
              }

              if ( path.indexOf('.') == -1 )
              {
                value = { [path]: value }
                path = ''
              }
              
              return {
                context: context,
                updates: [{
                  timestamp: ts,
                  $source: source,
                  values: [{
                    path: path,
                    value: value
                  }]
                }]
              }
            }
          }).filter(d => d != null)

          if ( attitude.timestamp ) {
            const ts = attitude.timestamp
            const $source = attitude.$source
            const context = attitude.context
            delete attitude.timestamp
            delete attitude.$source
            delete attitude.context
            deltas.push({
              context: context,
              updates: [{
                timestamp: ts,
                $source: $source,
                values: [{
                  path: 'navigation.attitude',
                    value: attitude
                }]
              }]
            })
          }

          //this is for backwards compatibility
          if ( skPath == null || skPath === 'navigation' || skPath === 'navigation.position' ) {
            let posQuery = `select value from "navigation.position" where ${whereClause} order by time desc limit 1`
            client.query(posQuery).then(result => {
              if ( result.length > 0 ) {
                let pos = JSON.parse(result[0].value)
                deltas.push({
                  context: 'vessels.' + app.selfId,
                  updates: [{
                    timestamp: result[0].time.toISOString(),
                    values: [{
                      path: 'navigation.position',
                      value: {
                        latitude: pos[1],
                        longitude: pos[0]
                      }
                  }]
                  }]
                })
              }
              cb(deltas)
            })
          }
          else
          {
            cb(deltas)
          }
        }).catch(err => {
          console.error(err)
        })    
    }).catch(err => {
      console.error(err)
    })    
  }


  let plugin = {
    id: 'signalk-to-influxdb',
    name: 'InfluxDb writer',
    description: 'Signal K server plugin that writes self values to InfluxDb',

    schema: {
      type: 'object',
      required: ['host', 'port', 'database'],
      properties: {
        protocol: {
          type: 'string',
          enum: [
            'http',
            'https'
          ],
          default: 'http'
        },
        host: {
          type: 'string',
          title: 'Host',
          default: 'localhost'
        },
        port: {
          type: 'number',
          title: 'Port',
          default: 8086
        },
        username: {
          type: 'string',
          title: 'Username (not required if InfluxDb is not authenticated)'
        },
        password: {
          type: 'string',
          title: 'Password'
        },
        database: {
          type: 'string',
          title: 'Database'
        },
        batchWriteInterval: {
          type: 'number',
          title: "Batch writes interval (in seconds, 0 means don't batch)",
          default: 10,
        },
        resolution: {
          type: 'number',
          title: 'Resolution (ms)',
          default: 200
        },
        recordTrack: {
          type: "boolean",
          title: "Record Track",
          description: "When enabled the vessels position will be stored",
          default: false
        },
        separateLatLon: {
          type: "boolean",
          title: "Latitude and Longitude as separate measurements to Influxdb",
          description: "Enable location data to be used in various ways e.g. in Grafana (mapping, functions, ...)",
          default: false
        },
        overrideTimeWithNow: {
          type: "boolean",
          title: "Override time with current timestamp",
          description: "By default the timestamp in the incoming data is used. Check this if you want log playback to simulate getting new data",
          default: false
        },
        storeOthers: {
          type: "boolean",
          title: "Record Others",
          description: "When enabled data from other vessels, atons and sar aircraft will be stored ",
          default: false
        },
        blackOrWhite: {
          type: 'string',
          title: 'Type of List',
          description:
            'With a blacklist, all numeric values except the ones in the list below will be stored in InfluxDB. With a whitelist, only the values in the list below will be stored.',
          default: 'Black',
          enum: ['White', 'Black']
        },
        blackOrWhitelist: {
          title: 'SignalK Paths',
          description:
            'A list of SignalK paths to be exluded or included based on selection above',
          type: 'array',
          items: {
            type: 'string',
            title: 'Path'
          }
        }
      }
    },

    start: function (options) {
      started = true

      let retryTimeout = 1000
      function connectToInflux() {
        if (!started) {
          clientP = Promise.reject('Not started')
          //Ignore the rejection, otherwise Node complains
          clientP.catch(() =>{})
          return
        }
        clientP = influxClientP(options)
        clientP.catch(err => {
          console.error(`Error connecting to InfluxDb, retrying in ${retryTimeout} ms`)
          setTimeout(() => {
            connectToInflux()
          }, retryTimeout)
          retryTimeout *= retryTimeout > 30 * 1000 ? 1 : 2
        })
      }
      connectToInflux()

      if ( app.registerHistoryProvider ) {
        app.registerHistoryProvider(plugin)
      }

      if (
        typeof options.blackOrWhitelist !== 'undefined' &&
        typeof options.blackOrWhite !== 'undefined' &&
        options.blackOrWhitelist.length > 0
      ) {
        var obj = {}

        options.blackOrWhitelist.forEach(element => {
          obj[element] = true
        })

        if (options.blackOrWhite == 'White') {
          shouldStore = function (path) {
            return typeof obj[path] !== 'undefined'
          }
        } else {
          shouldStore = function (path) {
            return typeof obj[path] === 'undefined'
          }
        }
      }
      let deltaToPoints = deltaToPointsConverter(selfContext, options.recordTrack, options.separateLatLon, shouldStore, options.resolution || 200, options.storeOthers, !options.overrideTimeWithNow)
      let accumulatedPoints = []
      let lastWriteTime = Date.now()
      let batchWriteInterval = (typeof options.batchWriteInterval === 'undefined' ? 10 : options.batchWriteInterval) * 1000
      const handleDelta = delta => {
        const points = deltaToPoints(delta)
        if (points.length > 0) {
          accumulatedPoints = accumulatedPoints.concat(points)
          let now = Date.now()
          if  ( batchWriteInterval == 0 || now - lastWriteTime > batchWriteInterval ) {
            lastWriteTime = now
            clientP
              .then(client => {
                const thePoints = accumulatedPoints
                accumulatedPoints = []
                return client.writePoints(thePoints)
              })
              .catch(error => {
                logError(error)
                accumulatedPoints = []
              })
          }
        }
      }
      app.signalk.on('delta', handleDelta)
      const pruneInterval = setInterval(() => {
        pruneTimestamps(1000 * options.resolution)
      }, 100 * options.resolution)
      unsubscribes.push(() => {
        app.signalk.removeListener('delta', handleDelta)
        clearInterval(pruneInterval)
      })

      registerHistoryApiRoute(app, clientP, app.selfId)
    },
    stop: function () {
      unsubscribes.forEach(f => f())
      started = false
    },
    signalKApiRoutes: function (router) {
      const trackHandler = function (req, res, next) {
        if (typeof clientP === 'undefined') {
          console.error(
            'signalk-to-influxdb plugin not enabled, http track interface not available'
          )
          next()
          return
        }

        let endTime = req.query.timespanOffset ? endTimeExpression(req.query.timespan, req.query.timespanOffset) : null;
        let startTime = req.query.timespanOffset ? offset(req.query.timespan, req.query.timespanOffset) : sanitize(req.query.timespan || '1h');

        let query = `
        select first(value) as "position", first(jsonValue) as "jsonPosition"
        from "navigation.position"
        where context = '${selfContext}'
        and time >= now() - ${startTime} ${endTime ? ' and time <= ' + endTime + ' ' : ''}
        group by time(${sanitize(req.query.resolution || '1m')})`
        
        clientP.then(client => {
          client.query(query)
          .then(result => {
            res.type('application/vnd.geo+json')
            res.json(toMultilineString(result))
          })
        }).catch(err => {
          console.error(err.message + ' ' + query)
          res.status(500).send(err.message + ' ' + query)
        })

      }

      router.get('/self/track', trackHandler)
      router.get('/vessels/self/track', trackHandler)
      router.get('/vessels/' + app.selfId + '/track', trackHandler)

      return router
    },

    historyStreamers: {},
    streamHistory: (cookie, options, onDelta) => {
      let playbackRate = options.playbackRate || 1
      
      let startTime = options.startTime

      app.debug(`starting streaming: ${startTime} ${playbackRate} `)

      let pathElements = getPathFromOptions(options)

      plugin.historyStreamers[cookie] = setInterval( () => {
        let endTime = new Date(startTime.getTime() + (1000 * playbackRate))
        getHistory(startTime, endTime, pathElements, (deltas) => {
          app.debug(`sending ${deltas.length} deltas`)
          deltas.forEach(onDelta)
        })
        startTime = endTime
      }, 1000)

      return () => {
        app.debug(`stop streaming: ${cookie}`)
        clearInterval(plugin.historyStreamers[cookie])
        delete plugin.historyStreamers[cookie]
      }
    },

    hasAnyData: (options, cb) => {
      const pathElements = getPathFromOptions(options)
      const endTime = new Date(options.startTime.getTime() + (1000 * 10))
      const { query, skPath } = getQuery(options.startTime, endTime, pathElements)
      
      clientP.then(client => {
        client.query(`select count(*) from ${query}`)
          .then(result => {
            cb(result.length > 0)
          }).catch(err => {
            console.error(err)
            cb(false)
          })    
      }).catch(err => {
        console.error(err)
        cb(false)
      })
    },
    
    getHistory: (date, pathElements, cb) => {
      let startTime = new Date(date.getTime() - (1000 * 60 * 5))
      getHistory(startTime, date, pathElements, (deltas) => {
        cb(deltas)
      })
    },

  }
  return plugin
}

const influxDurationKeys = {
  s: 's',
  m: 'm',
  h: 'h',
  d: 'd',
  w: 'w'
}

function sanitize (influxTime) {
  return (
    Number(influxTime.substring(0, influxTime.length - 1)) +
    influxDurationKeys[
      influxTime.substring(influxTime.length - 1, influxTime.length)
    ]
  )
}


function getPathFromOptions(options) {
  if ( options.subscribe && options.subscribe === 'self' ) {
    return ['vessels', 'self']
  } else {
    return null
  }
}

// offset an influxTime value by offsetTime
function offset(influxTime, offsetTime) {
    let tKey= influxTime.slice(-1)
    if(isNaN(offsetTime)) { return sanitize(influxTime) }

    let oVal= Number(influxTime.substring(0, influxTime.length - 1) ) + Math.abs( Number(offsetTime) )
    return sanitize( oVal + influxDurationKeys[tKey] )
}

function endTimeExpression(timespanValue, offsetValue) {
    if(isNaN(offsetValue)) { return null }
    else {
        let tKey= timespanValue.slice(-1) // timespan Y value
        return `now() - ${Math.abs( Number(offsetValue) ) + influxDurationKeys[ tKey ]}`
    }
}