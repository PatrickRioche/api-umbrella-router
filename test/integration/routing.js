'use strict';

require('../test_helper');

var _ = require('lodash'),
    Factory = require('factory-lady'),
    request = require('request');

describe('routing', function() {
  beforeEach(function createUser(done) {
    Factory.create('api_user', { settings: { rate_limit_mode: 'unlimited' } }, function(user) {
      this.apiKey = user.api_key;
      this.options = {
        strictSSL: false,
      };

      done();
    }.bind(this));
  });

  describe('web admin', function() {
    it('routes to the admin app for the default host', function(done) {
      this.timeout(5000);
      var options = _.merge({}, this.options, {
        headers: {
          'Host': 'default.foo',
        },
      });
      request.get('https://localhost:9081/admin/login', options, function(error, response, body) {
        should.not.exist(error);
        response.statusCode.should.eql(200);
        body.should.contain('Admin Login');
        done();
      });
    });

    it('routes to the admin app for unknown hosts when there is a default host', function(done) {
      this.timeout(5000);
      var options = _.merge({}, this.options, {
        headers: {
          'Host': 'unknown.foo',
        },
      });
      request.get('https://localhost:9081/admin/login', options, function(error, response, body) {
        should.not.exist(error);
        response.statusCode.should.eql(200);
        body.should.contain('Admin Login');
        done();
      });
    });

    it('does not route to the admin app for non-default hosts that are explicitly defined', function(done) {
      var options = _.merge({}, this.options, {
        headers: {
          'Host': 'withoutweb.foo',
        },
      });
      request.get('https://localhost:9081/admin/login', options, function(error, response) {
        should.not.exist(error);
        response.statusCode.should.eql(404);
        done();
      });
    });

    it('allows for routing to the web admin for non-default hosts if explicitly enabled', function(done) {
      this.timeout(5000);
      var options = _.merge({}, this.options, {
        headers: {
          'Host': 'withweb.foo',
        },
      });
      request.get('https://localhost:9081/admin/login', options, function(error, response, body) {
        should.not.exist(error);
        response.statusCode.should.eql(200);
        body.should.contain('Admin Login');
        done();
      });
    });

    it('redirects to https for the admin', function(done) {
      var options = _.merge({}, this.options, {
        followRedirect: false,
        headers: {
          'Host': 'default.foo',
        },
      });
      request.get('http://localhost:9080/admin/login', options, function(error, response) {
        should.not.exist(error);
        response.statusCode.should.eql(301);
        response.headers.location.should.eql('https://default.foo:9081/admin/login');
        done();
      });
    });

    it('redirects to the same host when performing the https redirect for the admin', function(done) {
      var options = _.merge({}, this.options, {
        followRedirect: false,
        headers: {
          'Host': 'unknown.foo',
        },
      });
      request.get('http://localhost:9080/admin/login', options, function(error, response) {
        should.not.exist(error);
        response.statusCode.should.eql(301);
        response.headers.location.should.eql('https://unknown.foo:9081/admin/login');
        done();
      });
    });

    it('redirects to the same host when performing the login redirect for the admin', function(done) {
      this.timeout(5000);
      var options = _.merge({}, this.options, {
        followRedirect: false,
        headers: {
          'Host': 'unknown.foo',
        },
      });
      request.get('https://localhost:9081/admin/', options, function(error, response) {
        should.not.exist(error);
        response.statusCode.should.eql(302);
        response.headers.location.should.eql('https://unknown.foo:9081/admin/login');
        done();
      });
    });
  });

  describe('api backends', function() {
    it('routes to the apis for any path prefixes matching apis', function(done) {
      var options = _.merge({}, this.options, {
        headers: {
          'Host': 'with-apis-and-website.foo',
        },
      });
      request.get('http://localhost:9080/example/', options, function(error, response, body) {
        should.not.exist(error);
        response.statusCode.should.eql(403);
        body.should.contain('API_KEY_MISSING');

        request.get('http://localhost:9080/info/test/extra/stuff', options, function(error, response, body) {
          should.not.exist(error);
          response.statusCode.should.eql(403);
          body.should.contain('API_KEY_MISSING');
          done();
        });
      });
    });

    it('matches url prefxies case-sensitively', function(done) {
      var options = _.merge({}, this.options, {
        headers: {
          'Host': 'with-apis-and-website.foo',
        },
      });
      request.get('http://localhost:9080/EXAMPLE/', options, function(error, response, body) {
        should.not.exist(error);
        response.statusCode.should.eql(404);
        body.should.contain('Test 404 Not Found');
        done();
      });
    });

    it('matches wildcards with *. syntax', function(done) {
      var options = _.merge({}, this.options, {
        headers: {
          'Host': 'test.wildcard-star-dot-subdomain.foo',
          'X-Api-Key': this.apiKey,
        },
      });
      request.get('http://localhost:9080/wildcard-star-dot-info/', options, function(error, response, body) {
        should.not.exist(error);
        response.statusCode.should.eql(200);
        var data = JSON.parse(body);
        data.headers['host'].should.eql('test.wildcard-star-dot-replacement.foo');

        options.headers['Host'] = 'wildcard-star-dot-subdomain.foo';
        request.get('http://localhost:9080/wildcard-star-dot-info/', options, function(error, response) {
          should.not.exist(error);
          response.statusCode.should.eql(404);
          done();
        });
      });
    });

    it('matches wildcards with . syntax', function(done) {
      var options = _.merge({}, this.options, {
        headers: {
          'Host': 'test.wildcard-dot-subdomain.foo',
          'X-Api-Key': this.apiKey,
        },
      });
      request.get('http://localhost:9080/wildcard-dot-info/', options, function(error, response, body) {
        should.not.exist(error);
        response.statusCode.should.eql(200);
        var data = JSON.parse(body);
        data.headers['host'].should.eql('test.wildcard-dot-replacement.foo');

        options.headers['Host'] = 'wildcard-dot-subdomain.foo';
        request.get('http://localhost:9080/wildcard-dot-info/', options, function(error, response, body) {
          response.statusCode.should.eql(200);
          data = JSON.parse(body);
          data.headers['host'].should.eql('wildcard-dot-replacement.foo');
          done();
        });
      });
    });

    it('routes to the api-umbrella internal apis for the default host', function(done) {
      var options = _.merge({}, this.options, {
        followRedirect: false,
        headers: {
          'Host': 'default.foo',
        },
      });
      request.get('https://localhost:9081/api-umbrella/v1/', options, function(error, response, body) {
        should.not.exist(error);
        response.statusCode.should.eql(403);
        body.should.contain('API_KEY_MISSING');
        done();
      });
    });

    it('routes to the api-umbrella internal apis for unknown hosts when there is a default host', function(done) {
      var options = _.merge({}, this.options, {
        followRedirect: false,
        headers: {
          'Host': 'unknown.foo',
        },
      });
      request.get('https://localhost:9081/api-umbrella/v1/', options, function(error, response, body) {
        should.not.exist(error);
        response.statusCode.should.eql(403);
        body.should.contain('API_KEY_MISSING');
        done();
      });
    });

    it('does not route to the api-umbrella internal apis for non-default hosts that are explicitly defined', function(done) {
      var options = _.merge({}, this.options, {
        followRedirect: false,
        headers: {
          'Host': 'with-apis-no-website.foo',
        },
      });
      request.get('https://localhost:9081/api-umbrella/v1/', options, function(error, response, body) {
        should.not.exist(error);
        response.statusCode.should.eql(404);
        body.should.contain('404 Not Found');
        done();
      });
    });
  });

  describe('website backends', function() {
    it('routes to the default static site website for the default host', function(done) {
      var options = _.merge({}, this.options, {
        headers: {
          'Host': 'default.foo',
        },
      });
      request.get('http://localhost:9080/', options, function(error, response, body) {
        should.not.exist(error);
        response.statusCode.should.eql(200);
        body.should.contain('Your API Site Name');

        request.get('https://localhost:9081/signup/', options, function(error, response, body) {
          should.not.exist(error);
          response.statusCode.should.eql(200);
          body.should.contain('API Key Signup');
          done();
        });
      });
    });

    it('routes to the default static site website for unknown hosts when there is a default host', function(done) {
      var options = _.merge({}, this.options, {
        headers: {
          'Host': 'unknown.foo',
        },
      });
      request.get('http://localhost:9080/', options, function(error, response, body) {
        should.not.exist(error);
        response.statusCode.should.eql(200);
        body.should.contain('Your API Site Name');
        done();
      });
    });

    it('routes to a custom website backend when it is defined for a specific hostname', function(done) {
      var options = _.merge({}, this.options, {
        headers: {
          'Host': 'with-apis-and-website.foo',
        },
      });
      request.get('http://localhost:9080/', options, function(error, response, body) {
        should.not.exist(error);
        response.statusCode.should.eql(200);
        body.should.contain('Test Home Page');
        done();
      });
    });

    it('routes to the website backend for any url not matched by the apis or web admin', function(done) {
      var options = _.merge({}, this.options, {
        headers: {
          'Host': 'with-apis-and-website.foo',
        },
      });
      request.get('http://localhost:9080/sjkdlfjksdlfj', options, function(error, response, body) {
        should.not.exist(error);
        response.statusCode.should.eql(404);
        body.should.contain('Test 404 Not Found');
        done();
      });
    });

    it('routes to the default nginx 404 page for hosts that have apis but no website', function(done) {
      var options = _.merge({}, this.options, {
        headers: {
          'Host': 'with-apis-no-website.foo',
        },
      });
      request.get('http://localhost:9080/', options, function(error, response, body) {
        should.not.exist(error);
        response.statusCode.should.eql(404);
        body.should.contain('404 Not Found');
        body.should.contain('nginx');
        done();
      });
    });

    it('redirects to https for the signup page by default', function(done) {
      var options = _.merge({}, this.options, {
        followRedirect: false,
        headers: {
          'Host': 'default.foo',
        },
      });
      request.get('http://localhost:9080/signup', options, function(error, response) {
        should.not.exist(error);
        response.statusCode.should.eql(301);
        response.headers.location.should.eql('https://default.foo:9081/signup');
        done();
      });
    });
  });
});
