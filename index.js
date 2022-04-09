import fetch from 'node-fetch';

/******************************** CONFIG **********************************/

import config from './config.js';

const apiEndpoints = {
  streamrNetwork: 'https://brubeck1.streamr.network:3013',
  cryptoCompare: 'https://min-api.cryptocompare.com',
  theGraph: 'https://api.thegraph.com',
}

/******************************* FUNCTIONS ********************************/

const mask = (str, pad = 10) => `0x******${str.slice(pad * -1)}`;
const toFixedFloat = (amount, digits = 2) => Number.parseFloat(amount).toFixed(digits);
const generateValueString = (dataAmount, eurRate) => `${toFixedFloat(dataAmount)} DATA (${toFixedFloat(dataAmount * eurRate)} €)`
const getGraphQueries = (address) => {
  return {
    balances: `{
      erc20Balances(where: { account: "${address.toLowerCase()}" })
      {
        value
      }
    } `,
    transfers: `{
      erc20Transfers(where: { from: "0x3979f7d6b5c5bfa4bcd441b4f35bfa0731ccfaef" to: "${address.toLowerCase()}" timestamp_gt: "1646065752" })
      {
        timestamp
        value 
          toBalance {
          value
        }
      }
    } `
  }
}

const executeHttpRequest = async (url, params) => {
  // console.log(`>> ${params.method.toUpperCase()} ${url}`)
  return (await fetch(url, params)).json;
}

const getInterestRates = async () => {
  console.log(`Getting interest rates (averages for past 24h)`);
  const interestRates = await executeHttpRequest(`${apiEndpoints.streamrNetwork}/apy`, {
    method: 'get',
    headers: { 'Content-Type': 'application/json' }
  })
  return {
    apr: interestRates['24h-APR'],
    apy: interestRates['24h-APY']
  }
};

const getDataToEurRate = async () => {
  console.log('Getting DATA to EUR rate')
  const rateData = await executeHttpRequest(`${apiEndpoints.cryptoCompare}/data/price?fsym=DATA&tsyms=EUR`, {
    method: 'get',
    headers: {
      'Content-Type': 'application/json',
    }
  })
  return rateData.EUR;
};

const executeGraphQuery = async (queryType, address) => {
  if (!address) {
    throw Error(`'address' is not defined!`);
  }
  const query = getGraphQueries(address)[queryType];
  if (!query) {
    throw Error(`Graph query type '${queryType}' is not supported`);
  }

  const graphData = await executeHttpRequest(`${apiEndpoints.theGraph}/subgraphs/name/streamr-dev/data-on-polygon`, {
    method: 'post',
    body: JSON.stringify({ query })
  })
  return graphData.data;
}

const fetchRewards = () => Promise.all(config.nodeAddresses.map(async (address) => {
  console.log(`Getting rewards, balances and transactions for ${mask(address)}`);
  const streamrRewardsData = await executeHttpRequest(`${apiEndpoints.streamrNetwork}/datarewards/${address}`, {
    method: 'get',
    headers: { 'Content-Type': 'application/json' }
  })
  const accumulatedRewards = streamrRewardsData.DATA;

  const streamrClaimsData = await executeHttpRequest(`${apiEndpoints.streamrNetwork}/stats/${address}`, {
    method: 'get',
    headers: { 'Content-Type': 'application/json' }
  })
  const claimedRewardCodes = streamrClaimsData.claimedRewardCodes;
  let firstClaimDate, lastClaimDate = '<no claimed rewards yet>';
  if (claimedRewardCodes && claimedRewardCodes.length > 0) {
    firstClaimDate = claimedRewardCodes[0].claimTime;
    lastClaimDate = claimedRewardCodes[claimedRewardCodes.length - 1].claimTime;
  }

  const transfersData = await executeGraphQuery('transfers', address);
  const transactions = transfersData.erc20Transfers.map(transfer => {
    const date = new Date(transfer.timestamp * 1000);
    return {
      date,
      value: Number(transfer.value),
      balance: Number(transfer.toBalance.value)
    };
  });
  const paidRewards = transactions.reduce((acc, n) => acc + n.value, 0);

  const balancesData = await executeGraphQuery('balances', address)
  const stake = Number(balancesData.erc20Balances[0].value);

  return {
    address,
    firstClaimDate,
    lastClaimDate,
    stake,
    transactions,
    paidRewards,
    accumulatedRewards,
    pendingRewards: accumulatedRewards - paidRewards
  };
}));

/**************************************************************************/

const eurRate = await getDataToEurRate();
const interestRates = await getInterestRates();
const rewards = (await fetchRewards()).sort(node => config.nodeAddresses.indexOf(node.address));
console.log(`--------------------------------------------------------`);
console.log(` Node statistics`)
console.log(`--------------------------------------------------------`);
let index = 1;
rewards.forEach(node => {
  console.log(`Node ${index++}: ${mask(node.address)}`);
  console.log(`  First claim on: ${node.firstClaimDate}`)
  console.log(`  Last claim on: ${node.lastClaimDate}`)
  console.log(`  Current stake: ${generateValueString(node.stake, eurRate)}`)
  console.log(`  Rewards paid: ${generateValueString(node.paidRewards, eurRate)}`)
  console.log(`  Rewards pending: ${generateValueString(node.pendingRewards, eurRate)}`)
  console.log(`  Rewards total: ${generateValueString(node.accumulatedRewards, eurRate)}\n`)
});

const totalMonthlyRewards = {};
const allTxs = rewards.flatMap(rewards => rewards.transactions).sort(tx => tx.date);
allTxs.forEach(tx => {
  const date = tx.date.toISOString().substring(0, 7);
  totalMonthlyRewards[date] = (totalMonthlyRewards[date] || 0.0) + tx.value;
});
const totalPaidRewards = rewards.reduce((acc, n) => acc + n.paidRewards, 0);
const totalPendingRewards = rewards.reduce((acc, n) => acc + n.pendingRewards, 0);
const totalAccumulatedRewards = rewards.reduce((acc, n) => acc + n.accumulatedRewards, 0);
const totalStake = rewards.reduce((acc, n) => acc + n.stake, 0);
const roi = 100.0 / (totalStake-totalPaidRewards) * totalAccumulatedRewards;
console.log(`--------------------------------------------------------`);
console.log(` Total rewards`)
console.log(`--------------------------------------------------------`);
console.log(`Rewards per month (by month of payment):`);
Object.keys(totalMonthlyRewards).forEach(date => {
  console.log(`    ${date}: ${generateValueString(totalMonthlyRewards[date], eurRate)}`)
});
console.log(`\nPaid rewards: ${generateValueString(totalPaidRewards, eurRate)}`);
console.log(`Pending rewards: ${generateValueString(totalPendingRewards, eurRate)}`);
console.log(`Total rewards: ${generateValueString(totalAccumulatedRewards, eurRate)}`);
console.log(`Total stake: ${generateValueString(totalStake, eurRate)}`);
console.log(`\nCurrent ROI (assuming nothing has been withdrawn): ${toFixedFloat(roi)}%`);

const estimatedYearlyRewardsApr = totalStake / 100.0 * interestRates.apr;
const estimatedYearlyRewardsApy = totalStake / 100.0 * interestRates.apy;
console.log(`--------------------------------------------------------`);
console.log(` Estimated rewards`)
console.log(`--------------------------------------------------------`);
console.log(`Rewards based on APR (${interestRates.apr}%, no compounding):`);
console.log(`    Monthly: ${generateValueString(estimatedYearlyRewardsApr / 12, eurRate)}`);
console.log(`    Yearly: ${generateValueString(estimatedYearlyRewardsApr, eurRate)}`);
console.log(`Rewards based on APY (${interestRates.apy}%, compounding):`);
console.log(`    Monthly: ${generateValueString(estimatedYearlyRewardsApy / 12, eurRate)}`);
console.log(`    Yearly: ${generateValueString(estimatedYearlyRewardsApy, eurRate)}`);
console.log(`--------------------------------------------------------`);
console.log(`EUR values are based on DATA price of ${toFixedFloat(eurRate, 4)} €`)
console.log(`--------------------------------------------------------`);
