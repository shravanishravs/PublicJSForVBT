const path = require('path');
var fs = require('fs');
const puppeteer = require('puppeteer-core');

module.exports = async function(vlocity, currentContextData, jobInfo, callback) {

VlocityUtils.report("Activating ALL FlexCards");

    let puppeteerOptions = await getPuppeteerOptions(jobInfo);
    

    if (!puppeteerOptions.executablePath && !jobInfo.puppeteerInstalled) {
        VlocityUtils.error('Chromium not installed. LWC activation disabled. Run "npm install puppeteer -g" or set puppeteerExecutablePath in your Job File');
        jobInfo.ignoreLWCActivationCards = true;
        jobInfo.ignoreLWCActivationOS = true;
    } else {
        
        let package = vlocity.namespacePrefix;
        let siteUrl = vlocity.jsForceConnection.instanceUrl;
        let sessionToken = vlocity.jsForceConnection.accessToken;
        let loginURl = siteUrl + '/secur/frontdoor.jsp?sid=' + sessionToken;
        let browser;

        const query = 'SELECT Id ' +
                      'FROM ' + package + 'VlocityCard__c ' +
                      'WHERE ' + package + 'Active__c = true AND ' + package + "CardType__c = 'flex' ";
      
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
    
        let idsArrayString = '';
        //console.log(idsArray.records.length);
        for (let i = 0; i < idsArray.records.length; i++) {
            let cardId = idsArray.records[i].Id;
            idsArrayString = idsArrayString + cardId + ','
        }
        idsArrayString = idsArrayString.substring(0, idsArrayString.length - 1);


        let flexCardCompilePage = siteUrl + '/apex/' + package + 'FlexCardCompilePage?id=' + idsArrayString;

        VlocityUtils.report('Starting LWC Activation For all Flex Cards', ' Number of FlexCards to compile: ' +  idsArray.records.length);

        VlocityUtils.report('LWC FlexCards Activation URL', flexCardCompilePage);

        let errorMessage;
        await page.goto(flexCardCompilePage, {timeout: loginTimeout});
        await page.waitForTimeout(5000);
        
        let tries = 0;
        let jsonError;
        
        let maxNumOfTries = Math.ceil((60/jobInfo.defaultLWCPullTimeInSeconds)*jobInfo.defaultMinToWaitForLWCFlexCards)*idsArray.records.length;
        while (tries < maxNumOfTries && !jobInfo.ignoreLWCActivationCards) {
            try {
                let message;
                try {
                    message = await page.waitForSelector('#compileMessage-0');
                } catch (messageTimeout) {
                    VlocityUtils.verbose('Error', messageTimeout);
                    VlocityUtils.log('FlexCards LWC Activation', 'Loading Page taking too long - Retrying - Tries: ' + tries + ' of ' + maxNumOfTries);
                }
                
                if (message) { 
                    let currentStatus = await message.evaluate(node => node.innerText);
                    VlocityUtils.report('Activating LWC for All FlexCards', currentStatus);
                    jobInfo.elapsedTime = VlocityUtils.getTime();
                    VlocityUtils.report('Elapsed Time', jobInfo.elapsedTime);
                    if (currentStatus === 'DONE SUCCESSFULLY') {
                        VlocityUtils.success('LWC Activated','All LWC for FlexCards Activated');
                        let jsonResulNode  = await page.waitForSelector('#resultJSON-0');
                        let jsonResult = await jsonResulNode.evaluate(node => node.innerText);
                        console.log(jsonResult);
                        break;
                    } else if (currentStatus === 'DONE WITH ERRORS') {
                        let jsonResulNode  = await page.waitForSelector('#resultJSON-0');
                        jsonError = await jsonResulNode.evaluate(node => node.innerText);
                        //VlocityUtils.verbose('LWC FlexCards Compilation Error Result', jsonResulNode);
                        console.log(jsonError);
                        break;
                    } 
                }
            } catch (e) {
                VlocityUtils.error('Error Activating LWC',e);
            }
            tries++;
            await page.waitForTimeout(jobInfo.defaultLWCPullTimeInSeconds*1000);
        }

        if (tries == maxNumOfTries) {
            errorMessage = 'Activation took longer than ' + jobInfo.defaultMinToWaitForLWCFlexCards + ' minutes - Aborted';
        }
        
        if (errorMessage) {
            jobInfo.hasError = true;
        }
        browser.close();
    }
    callback();
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


