'use strict';

var _ = require('lodash'),
    apiUmbrellaConfig = require('api-umbrella-config'),
    async = require('async'),
    clc = require('cli-color'),
    config = require('api-umbrella-config').global(),
    events = require('events'),
    execFile = require('child_process').execFile,
    forever = require('forever-monitor'),
    fs = require('fs'),
    fsExtra = require('fs-extra'),
    glob = require('glob'),
    handlebars = require('handlebars'),
    http = require('http'),
    mkdirp = require('mkdirp'),
    mongoConnect = require('./mongo_connect'),
    mongoose = require('mongoose'),
    net = require('net'),
    path = require('path'),
    posix = require('posix'),
    processEnv = require('./process_env'),
    supervisord = require('supervisord'),
    url = require('url'),
    util = require('util'),
    uuid = require('node-uuid'),
    yaml = require('js-yaml');

var models = require('api-umbrella-gatekeeper').models(mongoose);

var ApiUser = models.ApiUser;

var Router = function() {
  this.initialize.apply(this, arguments);
};

util.inherits(Router, events.EventEmitter);
_.extend(Router.prototype, {
  initialize: function(options) {
    process.stdout.write('Starting api-umbrella...');
    this.startWaitLog = setInterval(function() {
      process.stdout.write('.');
    }, 2000);

    process.on('SIGHUP', this.reload.bind(this));
    process.on('SIGINT', this.stop.bind(this, function() {
      process.exit(0);
    }));

    apiUmbrellaConfig.loader({
      defaults: {},
      paths: [
        path.resolve(__dirname, '../config/default.yml'),
      ].concat(options.config),
    }, this.handleConfigReady.bind(this));
  },

  handleConfigReady: function(error, configLoader) {
    this.configLoader = configLoader;

    async.series([
      this.setupGlobalConfig.bind(this),
      this.permissionCheck.bind(this),
      this.internalConfigDefaults.bind(this),
      this.computedConfigValues.bind(this),
      this.reloadGlobalConfig.bind(this),
      this.prepare.bind(this),
      this.writeTemplates.bind(this),
      this.startSupervisor.bind(this),
      this.waitForProcesses.bind(this),
      this.waitForConnections.bind(this),
      mongoConnect,
      this.seedDatabase.bind(this),
      this.seedDatabaseWeb.bind(this),
      this.writeStaticSiteEnv.bind(this),
    ], this.finishStart.bind(this));
  },

  reload: function() {
    var configPath = processEnv.supervisordConfigPath();
    var execOpts = {
      env: processEnv.env(),
    };

    execFile('supervisorctl', ['-c', configPath, 'update'], execOpts, function() {
      async.parallel([
        function(callback) {
          execFile('supervisorctl', ['-c', configPath, 'kill', 'HUP', 'router-nginx'], execOpts, callback);
        },
        function(callback) {
          execFile('supervisorctl', ['-c', configPath, 'kill', 'HUP', 'web-nginx'], execOpts, callback);
        },
        function(callback) {
          execFile('supervisorctl', ['-c', configPath, 'kill', 'USR2', 'web-puma'], execOpts, callback);
        },
        function(callback) {
          execFile('supervisorctl', ['-c', configPath, 'serialrestart', 'gatekeeper:*'], execOpts, callback);
        },
        function(callback) {
          execFile('supervisorctl', ['-c', configPath, 'restart', 'config-reloader', 'distributed-rate-limits-sync', 'log-processor', 'router-log-listener'], execOpts, callback);
        },
      ], function(error) {
        if(error) {
          console.error('Error reloading: ', error);
        }
      });
    }.bind(this));
  },

  stop: function(callback) {
    this.stopCallback = callback;

    process.stdout.write('\nStopping api-umbrella...');

    if(this.configLoader) {
      this.configLoader.close();
    }

    if(this.supervisordProcess && this.supervisordProcess.running) {
      this.supervisordProcess.stop();
    } else {
      this.finishStop();
    }
  },

  prepare: function(callback) {
    mkdirp.sync(path.join(config.get('db_dir'), 'elasticsearch'));
    mkdirp.sync(path.join(config.get('db_dir'), 'mongodb'));
    mkdirp.sync(path.join(config.get('db_dir'), 'redis'));
    mkdirp.sync(path.join(config.get('log_dir'), 'supervisor'));
    mkdirp.sync(path.join(config.get('run_dir'), 'varnish/api-umbrella'));
    mkdirp.sync(config.get('tmp_dir'), { mode: parseInt('0777', 8) });

    if(config.get('user')) {
      var uid = posix.getpwnam(config.get('user')).uid;
      var gid = posix.getgrnam(config.get('group')).gid;

      fs.chownSync(path.join(config.get('db_dir'), 'elasticsearch'), uid, gid);
      fs.chownSync(path.join(config.get('db_dir'), 'mongodb'), uid, gid);
      fs.chownSync(path.join(config.get('db_dir'), 'redis'), uid, gid);
      fs.chownSync(path.join(config.get('log_dir'), 'supervisor'), uid, gid);
      fs.chownSync(path.join(config.get('run_dir'), 'varnish'), uid, gid);
      fs.chownSync(path.join(config.get('run_dir'), 'varnish/api-umbrella'), uid, gid);
      fs.chownSync(config.get('tmp_dir'), uid, gid);
    }

    callback();
  },

  internalConfigDefaults: function(callback) {
    var filePath = path.join(config.get('run_dir'), 'internal_config_defaults.yml');
    var defaults = yaml.safeDump({
      internal_apis: [
        {
          _id: 'api-umbrella-web-backend',
          name: 'API Umbrella - Default',
          frontend_host: '*',
          backend_host: 'localhost',
          backend_protocol: 'http',
          balance_algorithm: 'least_conn',
          sort_order: 1,
          servers: [
            {
              _id: uuid.v4(),
              host: 'localhost',
              port: config.get('web.port'),
            }
          ],
          url_matches: [
            {
              _id: uuid.v4(),
              frontend_prefix: '/api-umbrella/',
              backend_prefix: '/api-umbrella/',
            }
          ],
          sub_settings: [
            {
              _id: uuid.v4(),
              http_method: 'post',
              regex: '^/api-umbrella/v1/users',
              settings: {
                _id: uuid.v4(),
                required_roles: ['api-umbrella-key-creator'],
              },
            },
            {
              _id: uuid.v4(),
              http_method: 'post',
              regex: '^/api-umbrella/v1/contact',
              settings: {
                _id: uuid.v4(),
                required_roles: ['api-umbrella-contact-form'],
              },
            },
          ],
        },
      ],
    });

    fs.writeFile(filePath, defaults, function(error) {
      if(error) { return callback(error); }

      this.configLoader.options.paths.push(filePath);
      this.configLoader.reload(callback);
    }.bind(this));
  },

  computedConfigValues: function(callback) {
    var filePath = path.join(config.get('run_dir'), 'computed_config_values.yml');
    var defaults = yaml.safeDump({
      service_general_db_enabled: _.contains(config.get('services'), 'general_db'),
      service_log_db_enabled: _.contains(config.get('services'), 'log_db'),
      service_router_enabled: _.contains(config.get('services'), 'router'),
      service_web_enabled: _.contains(config.get('services'), 'web'),
    });

    fs.writeFile(filePath, defaults, function(error) {
      if(error) { return callback(error); }

      this.configLoader.options.paths.push(filePath);
      this.configLoader.reload(callback);
    }.bind(this));
  },

  setupGlobalConfig: function(callback) {
    apiUmbrellaConfig.setGlobal(this.configLoader.runtimeFile);
    config = require('api-umbrella-config').global();

    // A dance to move the runtime config file into a less temporary location.
    //
    // This could maybe be addressed better in the api-umbrella-config module,
    // but we want to install the runtime config file into a location based on
    // paths defined in the config file, so it's a little tricky.
    //
    // Copying the file also prevents a build-up of lots of temporary yaml
    // files, which is how api-umbrella-config will behave by default (since we
    // don't necessarily want api-umbrella-config to cleanup the files when it
    // closes, since other processes might be reading the files).
    var tempConfigPath = this.configLoader.runtimeFile;
    try {
      var permanentConfigPath = path.join(config.get('run_dir'), 'runtime_config.yml');
      fsExtra.copySync(tempConfigPath, permanentConfigPath);
      this.configLoader.runtimeFile = permanentConfigPath;
      apiUmbrellaConfig.setGlobal(this.configLoader.runtimeFile);
      config.reload();
    } finally {
      // Always cleanup the temp file, even if the app dies because
      // permanentConfigPath is not writable.
      fs.unlinkSync(tempConfigPath);
    }

    processEnv.overrideEnv({
      'API_UMBRELLA_CONFIG': this.configLoader.runtimeFile,
    });

    callback();
  },

  reloadGlobalConfig: function(callback) {
    config.reload();
    callback();
  },

  permissionCheck: function(callback) {
    if(config.get('user')) {
      if(posix.geteuid() !== 0) {
        return callback('Must be started with super-user privileges to change user to \'' + config.get('user') + '\'');
      }

      try {
        posix.getpwnam(config.get('user'));
      } catch(e) {
        return callback('User \'' + config.get('user') + '\' does not exist');
      }

    }

    if(config.get('group')) {
      if(posix.geteuid() !== 0) {
        return callback('Must be started with super-user privileges to change group to \'' + config.get('group') + '\'');
      }

      try {
        posix.getgrnam(config.get('group'));
      } catch(e) {
        return callback('Group \'' + config.get('group') + '\' does not exist');
      }

      // Change the process group id so the api-umbrella-config file that gets
      // written is readable by the api-umbrella group.
      process.setgid(config.get('group'));
    }

    if(config.get('http_port') < 1024 || config.get('https_port') < 1024) {
      if(posix.geteuid() !== 0) {
        return callback('Must be started with super-user privileges to use http ports below 1024');
      }
    }

    if(posix.geteuid() === 0) {
      if(!config.get('user') || !config.get('group')) {
        return callback('Must define a user and group to run worker processes as when starting with with super-user privileges');
      }
    }

    callback();
  },

  seedDatabase: function(callback) {
    async.series([
      function(seriesCallback) {
        var email = 'static.site.ajax@internal.apiumbrella';
        ApiUser.findOne({ email: email }, function(error, user) {
          if(error) { return seriesCallback(error); }

          if(!user) {
            user = new ApiUser({ _id: uuid.v4(), email: email });
          }

          user.set({
            first_name: 'API Umbrella Static Site',
            last_name: 'Key',
            website: 'http://' + config.get('default_host') + '/',
            use_description: 'An API key for the API Umbrella static website to use for ajax requests.',
            terms_and_conditions: '1',
            registration_source: 'seed',
            roles: ['api-umbrella-key-creator', 'api-umbrella-contact-form'],
            settings: {
              _id: uuid.v4(),
              rate_limit_mode: 'custom',
              rate_limits: [
                {
                  _id: uuid.v4(),
                  duration: 1 * 60 * 1000, // 1 minute
                  accuracy: 5 * 1000, // 5 seconds
                  limit_by: 'ip',
                  limit: 5,
                  response_headers: false,
                },
                {
                  _id: uuid.v4(),
                  duration: 60 * 60 * 1000, // 1 hour
                  accuracy: 1 * 60 * 1000, // 1 minute
                  limit_by: 'ip',
                  limit: 20,
                  response_headers: true,
                },
              ],
            },
          });

          this.staticSiteApiUser = user;
          user.save(seriesCallback);
        }.bind(this));
      }.bind(this),
    ], callback);
  },

  seedDatabaseWeb: function(callback) {
    execFile('bundle', ['exec', 'rake', 'db:seed_fu'], {
      cwd: config.get('web.dir'),
      env: processEnv.env(),
    }, callback);
  },

  writeTemplates: function(callback) {
    var templateConfig = _.extend({}, config.getAll(), {
      api_umbrella_config_runtime_file: this.configLoader.runtimeFile,
      api_umbrella_config_args: '--config ' + this.configLoader.runtimeFile,
      gatekeeper_hosts: _.times(config.get('gatekeeper.workers'), function(n) { return '127.0.0.1:' + (50000 + n); }),
      test_env: (config.get('app_env') === 'test'),
      development_env: (config.get('app_env') === 'development'),
      primary_hosts: _.filter(config.get('hosts'), function(host) { return !host.secondary; }),
      secondary_hosts: _.filter(config.get('hosts'), function(host) { return host.secondary; }),
      supervisor_conditional_user: (config.get('user')) ? 'user=' + config.get('user') : '',
    });

    var templateRoot = path.resolve(__dirname, '../templates/etc');
    glob(path.join(templateRoot, '**/*'), function(error, templatePaths) {
      async.each(templatePaths, function(templatePath, eachCallback) {
        if(fs.statSync(templatePath).isDirectory()) { return eachCallback(); }

        var installPath = templatePath.replace(/\.hbs$/, '');
        installPath = installPath.replace(templateRoot, '');
        installPath = path.join(config.get('etc_dir'), installPath);

        var content = '';

        // For the api_backends template, write an empty file, since we don't
        // have the necessary API backend information yet. This template gets
        // managed by the config_reloader worker process after things are
        // started.
        if(!_.contains(installPath, 'nginx/api_backends.conf')) {
          content = fs.readFileSync(templatePath).toString();
          if(/\.hbs$/.test(templatePath)) {
            var template = handlebars.compile(content);
            content = template(templateConfig);
          }
        }

        mkdirp.sync(path.dirname(installPath));
        fs.writeFile(installPath, content, eachCallback);
      }.bind(this), callback);
    }.bind(this));
  },

  startSupervisor: function(callback) {
    this.supervisordProcess = new (forever.Monitor)(['supervisord', '-c', processEnv.supervisordConfigPath(), '--nodaemon'], {
      max: 1,
      silent: true,
      logFile: path.join(config.get('log_dir'), 'supervisor/supervisord_forever.log'),
      outFile: path.join(config.get('log_dir'), 'supervisor/supervisord_forever.log'),
      errFile: path.join(config.get('log_dir'), 'supervisor/supervisord_forever.log'),
      append: true,
      env: processEnv.env(),
    });

    this.supervisordProcess.on('error', function() {
      console.info('error: ', arguments);
    });

    this.supervisordProcess.on('start', function() {
      callback();
    });

    this.supervisordProcess.on('exit', this.finishStop.bind(this));

    this.supervisordProcess.start();
  },

  waitForProcesses: function(callback) {
    var client = supervisord.connect('http://localhost:9009');
    var connected = false;
    var nonRunningProcesses = [];
    var attemptDelay = 100;
    async.until(function() {
      return connected;
    }, function(untilCallback) {
      client.getAllProcessInfo(function(error, result) {
        if(result && _.isEqual(_.uniq(_.pluck(result, 'statename')), ['RUNNING'])) {
          connected = true;
          untilCallback();
        } else {
          nonRunningProcesses = _.filter(result, function(process) { return process.statename !== 'RUNNING'; });
          setTimeout(untilCallback, attemptDelay);
        }
      });
    }, callback);

    setTimeout(function() {
      if(!connected) {
        if(nonRunningProcesses.length > 0) {
          callback('Failed to start processes:\n' + _.map(nonRunningProcesses, function(process) {
            return '  ' + process.name + ' (' + process.statename + ' - ' + process.logfile + ')';
          }).join('\n'));
        } else {
          callback('Failed to start - no services enabled');

        }
      }
    }.bind(this), 15000);
  },

  waitForConnections: function(callback) {
    var listeners = [];

    if(config.get('service_general_db_enabled')) {
      listeners = listeners.concat([
        'tcp://127.0.0.1:' + config.get('mongodb.embedded_server_config.port'),
      ]);
    }

    if(config.get('service_log_db_enabled')) {
      listeners = listeners.concat([
        'http://127.0.0.1:' + config.get('elasticsearch.embedded_server_config.http_port'),
      ]);
    }

    if(config.get('service_router_enabled')) {
      listeners = listeners.concat([
        'tcp://127.0.0.1:' + config.get('redis.port'),
        'tcp://127.0.0.1:' + config.get('varnish.port'),
        'tcp://127.0.0.1:' + config.get('http_port'),
      ]);
    }

    if(config.get('service_web_enabled')) {
      listeners = listeners.concat([
        'tcp://127.0.0.1:' + config.get('web.port'),
        'unix://' + config.get('run_dir') + '/web-puma.sock',
      ]);
    }

    var allConnected = (listeners.length === 0) ? true : false;
    var successfulConnections = [];

    async.each(listeners, function(listener, eachCallback) {
      var parsed = url.parse(listener);

      // Wait until we're able to establish a connection before moving on.
      var connected = false;
      var attemptDelay = 100;
      async.until(function() {
        return connected;
      }, function(untilCallback) {
        switch(parsed.protocol) {
          case 'http:':
            http.get(parsed.href, function(res) {
              if(res.statusCode === 200) {
                connected = true;
                successfulConnections.push(listener);
                untilCallback();
              } else {
                setTimeout(untilCallback, attemptDelay);
              }
            }).on('error', function() {
              setTimeout(untilCallback, attemptDelay);
            });
            break;
          case 'tcp:':
            net.connect({
              host: parsed.hostname,
              port: parsed.port,
            }).on('connect', function() {
              connected = true;
              successfulConnections.push(listener);
              untilCallback();
            }).on('error', function() {
              setTimeout(untilCallback, attemptDelay);
            });
            break;
          case 'unix:':
            net.connect({
              path: parsed.path,
            }).on('connect', function() {
              connected = true;
              successfulConnections.push(listener);
              untilCallback();
            }).on('error', function() {
              setTimeout(untilCallback, 100);
            });
            break;
        }
      }, eachCallback);
    }, function() {
      allConnected = true;
      callback();
    });

    setTimeout(function() {
      if(!allConnected) {
        callback('Unable to establish connections: ' + _.difference(listeners, successfulConnections).join(', '));
      }
    }.bind(this), 60000);
  },

  writeStaticSiteEnv: function(callback) {
    var envPath = path.join(config.get('static_site.dir'), '.env');
    var envLines = [];
    if(fs.existsSync(envPath)) {
      var env = fs.readFileSync(envPath);
      envLines = env.toString().split(/[\r\n]+/);
    }

    var apiKeyLine = 'API_UMBRELLA_API_KEY=' + this.staticSiteApiUser.api_key;
    if(envLines.indexOf(apiKeyLine) === -1) {
      envLines = _.reject(envLines, function(line) {
        return line.indexOf('API_UMBRELLA_API_KEY=') === 0;
      });

      envLines.push(apiKeyLine);
      fs.writeFile(envPath, envLines.join('\n'), function(error) {
        if(error) { return callback(error); }

        if(config.get('app_env') === 'development') {
          execFile('supervisorctl', ['-c', processEnv.supervisordConfigPath(), 'restart', 'static-site'], {
            env: processEnv.env(),
          }, callback);
        } else {
          execFile('bundle', ['exec', 'middleman', 'build'], {
            cwd: config.get('static_site.dir'),
            env: processEnv.env(),
          }, callback);
        }
      }.bind(this));
    } else {
      callback();
    }
  },

  finishStart: function(error) {
    if(error) {
      console.info(' [' + clc.red('FAIL') + ']\n');
      console.error(error);
      if(this.supervisordProcess) {
        console.error('\n  See ' + this.supervisordProcess.logFile + ' for more details');
      }

      this.stop(function() {
        process.exit(1);
      });
    } else {
      clearInterval(this.startWaitLog);
      console.info(' [  ' + clc.green('OK') + '  ]');
      this.emit('ready');
    }
  },

  finishStop: function() {
    if(this.configLoader) {
      this.configLoader.close();
    }

    console.info(' [  ' + clc.green('OK') + '  ]');

    if(this.stopCallback) {
      this.stopCallback();
    }
  },
});

_.extend(exports, {
  run: function(options, callback) {
    var router = new Router(options);
    if(callback) {
      router.once('ready', callback);
    }

    return router;
  },
});