const path = require('path');
var fs = require('fs');
const puppeteer = require('puppeteer-core');

module.exports = async function(vlocity, currentContextData, jobInfo, callback) {

VlocityUtils.report("Activating ALL OmniScripts");

    let puppeteerOptions = await getPuppeteerOptions(jobInfo);
    

    if (!puppeteerOptions.executablePath && !jobInfo.puppeteerInstalled) {
        VlocityUtils.error('Chromium not installed. LWC activation disabled. Run "npm install puppeteer -g" or set puppeteerExecutablePath in your Job File');
        jobInfo.ignoreLWCActivationCards = true;
        jobInfo.ignoreLWCActivationOS = true;
    } else {
        jobInfo.currentErrors = [];
        jobInfo.errors = [];
        let package = vlocity.namespacePrefix;
        let siteUrl = vlocity.jsForceConnection.instanceUrl;
        let sessionToken = vlocity.jsForceConnection.accessToken;
        let loginURl = siteUrl + '/secur/frontdoor.jsp?sid=' + sessionToken;
        let browser;

        const query = 'SELECT Id, Name ' +
                      'FROM vlocity_cmt__OmniScript__c ' +
                      'WHERE vlocity_cmt__IsActive__c = true and vlocity_cmt__IsProcedure__c = false AND vlocity_cmt__IsLwcEnabled__c = true ' +
                      'ORDER BY vlocity_cmt__IsReusable__c desc ';
      
        const idsArray = await vlocity.jsForceConnection.query(query);
        //console.log(puppeteerOptions);

        try {
            browser = await puppeteer.launch(puppeteerOptions);
        } catch (error) {
            VlocityUtils.error('Puppeteer initialization Failed, LWC Activation not completed - ' + error);
            return;
        }
        
        const page = await browser.newPage();
        const loginTimeout = 300000;

        await Promise.all([
            page.waitForNavigation({ timeout: loginTimeout, waitUntil: 'load' }),
            page.waitForNavigation({ timeout: loginTimeout, waitUntil: 'networkidle2'}),
            page.goto(loginURl, {timeout: loginTimeout})
        ]);
    
        VlocityUtils.report('TOTAL OmniScripts to Compile:', idsArray.records.length);

        for (let i = 0; i < idsArray.records.length; i++) {
            let omniScriptId = idsArray.records[i].Id;
            let omniScriptName = idsArray.records[i].Name;
            await compileOSLWC(jobInfo, omniScriptId, omniScriptName, page, siteUrl, package);
            VlocityUtils.report('Status:', (i+1) + '/' + idsArray.records.length + ' OmniScripts Compiled');
        }

        console.log(jobInfo.currentErrors);

        browser.close();
    }
    callback();
}

compileOSLWC = async function (jobInfo, omniScriptId, omniScriptKey, page, siteUrl, package) {

    VlocityUtils.verbose('Activating OmniScript ID', omniScriptKey + ' (' + omniScriptId + ')');
    
    var omniScriptDisignerpageLink = siteUrl + '/apex/' + package + 'OmniLwcCompile?id=' + omniScriptId + '&activate=true';
    var omniScriptLogId = omniScriptKey + ' (' + omniScriptId + ')';

    VlocityUtils.report('Starting OmniScript LWC Activation', omniScriptLogId);
    VlocityUtils.verbose('LWC Activation URL', omniScriptDisignerpageLink);
   
    await page.goto(omniScriptDisignerpageLink);
    await page.waitForTimeout(5000);

   
    let tries = 0;
    var errorMessage;
    var maxNumOfTries = Math.ceil((60/jobInfo.defaultLWCPullTimeInSeconds)*jobInfo.defaultMinToWaitForLWCOmniScript);
    while (tries < maxNumOfTries && !jobInfo.ignoreLWCActivationOS) {
        try {
            let message;
            try {
                message = await page.waitForSelector('#compiler-message');
            } catch (messageTimeout) {
                VlocityUtils.verbose('Error', messageTimeout);
                VlocityUtils.log(omniScriptKey, 'Loading Page taking too long - Retrying - Tries: ' + tries + ' of ' + maxNumOfTries);
            }
            
            if (message) { 
                let currentStatus = await message.evaluate(node => node.innerText);
                VlocityUtils.report('Activating LWC for OmniScript', omniScriptLogId, currentStatus);
                jobInfo.elapsedTime = VlocityUtils.getTime();
                VlocityUtils.report('Elapsed Time', jobInfo.elapsedTime);
                if (currentStatus === 'DONE') {
                    VlocityUtils.success('LWC Activated', omniScriptLogId);
                    break;
                } else if (/^ERROR: No MODULE named markup/.test(currentStatus)) {
                    var missingLWCTrimedError = currentStatus.substring('ERROR: '.length, currentStatus.indexOf(' found :'));
                    errorMessage = ' Missing Custom LWC - ' + missingLWCTrimedError;
                    break;
                } else if (/^ERROR/.test(currentStatus)) {
                    errorMessage = ' Error Activating LWC - ' + currentStatus;
                    break;
                }
            }
        } catch (e) {
            VlocityUtils.error('Error Activating LWC', omniScriptLogId, e);
            errorMessage = ' Error: ' + e;
        }
        tries++;
        await page.waitForTimeout(jobInfo.defaultLWCPullTimeInSeconds*1000);
    }

    if (tries == maxNumOfTries) {
        errorMessage = 'Activation took longer than ' + jobInfo.defaultMinToWaitForLWCOmniScript + ' minutes - Aborting';
    }

    if (errorMessage) {
        jobInfo.hasError = true;
        jobInfo.currentErrors[omniScriptKey] = 'LWC Activation Error >> ' + omniScriptKey + ' - ' + errorMessage;
        jobInfo.errors.push('LWC Activation Error >> ' + omniScriptKey + ' - ' + errorMessage);
        VlocityUtils.error('LWC Activation Error', omniScriptKey + ' - ' + errorMessage);
    }
}

getPuppeteerOptions = async function (jobInfo) {
    let puppeteerOptions = { 
        headless: jobInfo.puppeteerHeadless,
        args: [
            '--no-sandbox',
            `--proxy-server=${jobInfo.httpProxy ? jobInfo.httpProxy : ''}`
        ]
    };
    if (jobInfo.puppeteerHttpProxy) {
        puppeteerOptions.args.push('--proxy-server=' + jobInfo.puppeteerHttpProxy);
    }

    let macChrome = path.join('/', 'Applications', 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome');
    let winChrome = path.join('/', 'Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe');
    let winChrome86 = path.join('/', 'Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe');
    let linux = path.join('/','opt','google','chrome','chrome');
    let linux2 = path.join('/','opt','google','chrome','google-chrome');
    let linux3 = path.join('/','usr','bin','chromium-browser');    

    if (jobInfo.puppeteerExecutablePath) {
        puppeteerOptions.executablePath = jobInfo.puppeteerExecutablePath;
    } else if (fs.existsSync(macChrome)) {
        puppeteerOptions.executablePath = macChrome;
    } else if (fs.existsSync(winChrome)) {
        puppeteerOptions.executablePath = winChrome;
    } else if (fs.existsSync(winChrome86)) {
        puppeteerOptions.executablePath = winChrome86;
    } else if (fs.existsSync(linux)) {
        puppeteerOptions.executablePath = linux;
    } else if (fs.existsSync(linux2)) {
        puppeteerOptions.executablePath = linux2;
    } else if (fs.existsSync(linux3)) {
        puppeteerOptions.executablePath = linux3;        
    } else {
        let chromiumDirLocal = path.join('.', 'node_modules', 'puppeteer', '.local-chromium');
        if (fs.existsSync(chromiumDirLocal)) {
            fs.readdirSync(chromiumDirLocal).forEach((file) => {
                let macApp = path.join(chromiumDirLocal, file, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium');
                let linuxApp =  path.join(chromiumDirLocal, file, 'chrome-linux', 'chrome');
                let winApp =  path.join(chromiumDirLocal, file, 'chrome-win', 'chrome.exe');

                if (fs.existsSync(macApp)) {
                    puppeteerOptions.executablePath = macApp;
                } else if (fs.existsSync(linuxApp)) {
                    puppeteerOptions.executablePath = linuxApp;
                } else if (fs.existsSync(winApp)) {
                    puppeteerOptions.executablePath = winApp;
                }
            });
        }
        if (!puppeteerOptions.executablePath) {
            let pathToPuppeteer = require("global-modules-path").getPath("puppeteer", "puppeteer");
            if (pathToPuppeteer) {
                let chromiumDirGlobal = path.join(pathToPuppeteer, '.local-chromium');
                if (fs.existsSync(chromiumDirGlobal)) {
                    fs.readdirSync(chromiumDirGlobal).forEach((file) => {
                        let macApp = path.join(chromiumDirGlobal, file, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium');
                        let linuxApp =  path.join(chromiumDirGlobal, file, 'chrome-linux', 'chrome');
                        let winApp =  path.join(chromiumDirGlobal, file, 'chrome-win', 'chrome.exe');

                        if (fs.existsSync(macApp)) {
                            puppeteerOptions.executablePath = macApp;
                        } else if (fs.existsSync(linuxApp)) {
                            puppeteerOptions.executablePath = linuxApp;
                        } else if (fs.existsSync(winApp)) {
                            puppeteerOptions.executablePath = winApp;
                        }
                    });
                }   
            }
        }
    }

    if (puppeteerOptions.executablePath) {
        jobInfo.puppeteerExecutablePath = puppeteerOptions.executablePath;
    }
    //console.log(puppeteerOptions);
    return puppeteerOptions;
}


