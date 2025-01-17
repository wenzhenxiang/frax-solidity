const {expect} = require("chai");
const {ethers, network} = require("hardhat");
const {BigNumber} = require('ethers');
const UniV2TWAMMPair = require('../../artifacts/contracts/Uniswap_V2_TWAMM/core/UniV2TWAMMPair.sol/UniV2TWAMMPair');
const {BIG6, BIG18, bigNumberify, expandTo18Decimals, sleep} = require('./utilities');
const {
    calculateTwammExpectedFraxSwapIntervals,
    calculateTwammExpectedFraxSwap,
    executeVirtualOrdersUntilTimestamp,
    twammStateSnapshot,
    getAmountOutWithTwamm
} = require('./twamm-utils')
const chalk = require('chalk');
const util = require('util');

async function getBlockNumber() {
    return (await ethers.provider.getBlock("latest")).number
}

async function getBlockTimestamp() {
    return (await ethers.provider.getBlock("latest")).timestamp
}

function getErrorDiffPct(A, B) {
    const bigger = A > B ? A : B;
    const smaller = A < B ? A : B;
    return bigger.mul(10000).div(smaller).sub(10000)
}

function outputErrorDiffPct(A, B) {
    return `diff: ${ethers.utils.formatUnits(getErrorDiffPct(A, B), 2)} %`
}

function outputRatio(A, B) {
    return ethers.utils.formatUnits(A.mul(10000).div(B), 4)
}

const transactionInSingleBlock = async (func) => {
    await network.provider.send("evm_setAutomine", [false]);
    await func();
    await network.provider.send("evm_setAutomine", [true]);
    await network.provider.send("evm_mine")
}

const initialLiquidityProvided = expandTo18Decimals(100000);
const initialAddr3Token0 = expandTo18Decimals(1000000);
const initialAddr3Token1 = expandTo18Decimals(1000000);

let orderTimeInterval = 3600;

const ERC20Supply = expandTo18Decimals(1e22);

async function setupContracts(createPair = true) {
    const [owner, user1, user2, user3] = await ethers.getSigners();

    // Deploy token0/token1 token and distribute
    const DummyToken = await ethers.getContractFactory("contracts/Uniswap_V2_TWAMM/periphery/test/ERC20PeriTest.sol:ERC20PeriTest");
    let token0 = await DummyToken.deploy(ERC20Supply);
    let token1 = await DummyToken.deploy(ERC20Supply);
    const weth9 = await (await ethers.getContractFactory("WETH9")).deploy();

    if (token1.address.toUpperCase() < token0.address.toUpperCase()) {
        var temp = token1;
        token1 = token0;
        token0 = temp;
    }

    const FraxswapFactory = await ethers.getContractFactory("UniV2TWAMMFactory");
    const factory = await FraxswapFactory.deploy(owner.address);
    await factory.deployed();

    let pair;
    if (createPair) {
        await factory.createPair(token0.address, token1.address);
        const pairAddress = await factory.getPair(token0.address, token1.address);
        pair = new ethers.Contract(pairAddress, UniV2TWAMMPair.abi).connect(owner);
    }

    const FraxswapRouter = await ethers.getContractFactory("UniV2TWAMMRouter");
    const router = await FraxswapRouter.deploy(factory.address, weth9.address);
    await router.deployed();

    return {
        token0,
        token1,
        weth9,
        factory,
        pair,
        router
    }
}

const runOnce = () => describe("Test to Run Once", function () {

    describe("Calculate the UniswapV2Pair code hash", function () {
        it("Output the Init Hash", async function () {

            // do this twice because sometimes the hash differs depending on which solidity compiler is used

            // compute using ethers js
            const bytecode = UniV2TWAMMPair.bytecode;
            const COMPUTED_INIT_CODE_HASH = ethers.utils.keccak256(bytecode);
            console.log(`COMPUTED_INIT_CODE_HASH: ${COMPUTED_INIT_CODE_HASH}`);

            // compute with smart contract
            const ContractInitHash = await ethers.getContractFactory("ComputeUniswapV2PairInitHash");
            const contractInitHash = await (await ContractInitHash.deploy()).deployed();
            console.log(`getInitHash: ${await contractInitHash.getInitHash()}`);

        });
    });

    describe("External functions", function () {
        beforeEach(async function () {
            [owner, addr1, addr2, addr3, ...addrs] = await ethers.getSigners();

            let setupCnt = await setupContracts(false, false);
            token0 = setupCnt.token0;
            token1 = setupCnt.token1;
            factory = setupCnt.factory;

        });
        it("Everyone can call executeVirtualOrders", async function () {

            await factory.createPair(token0.address, token1.address);
            const pairAddress = await factory.getPair(token0.address, token1.address);
            twamm = new ethers.Contract(pairAddress, UniV2TWAMMPair.abi).connect(owner);

            await expect(
                twamm.connect(addr1).executeVirtualOrders(await getBlockTimestamp() + 1)
            ).to.not.be.reverted; // anyone can call this function

        });
    });

    describe("Pause Tests", function () {
        beforeEach(async function () {
            [owner, addr1, addr2, addr3, ...addrs] = await ethers.getSigners();

            let setupCnt = await setupContracts(false, false);
            token0 = setupCnt.token0;
            token1 = setupCnt.token1;
            factory = setupCnt.factory;

        });
        it("Pause enabled, withdraw", async function () {

            await factory.createPair(token0.address, token1.address);
            const pairAddress = await factory.getPair(token0.address, token1.address);
            twamm = new ethers.Contract(pairAddress, UniV2TWAMMPair.abi).connect(owner);

            await token0.transfer(twamm.address, initialLiquidityProvided);
            await token1.transfer(twamm.address, initialLiquidityProvided);
            await twamm.mint(owner.address);

            const amountIn = expandTo18Decimals(10);

            //trigger long term order
            await token0.transfer(addr1.address, amountIn);
            await token0.connect(addr1).approve(twamm.address, amountIn);
            await expect(twamm.connect(addr1).longTermSwapFrom0To1(amountIn, 2)).to.be.not.reverted;
            await token1.transfer(addr1.address, amountIn);
            await token1.connect(addr1).approve(twamm.address, amountIn);
            await expect(twamm.connect(addr1).longTermSwapFrom1To0(amountIn, 2)).to.be.not.reverted;

            //move blocks forward, and execute virtual orders
            await mineTimeIntervals(3)
            await twamm.connect(addr1).executeVirtualOrders(await getBlockTimestamp());

            // enabled twamm pause
            await twamm.togglePauseNewSwaps();

            //trigger long term order that should fail
            await token0.transfer(addr1.address, amountIn);
            await token0.connect(addr1).approve(twamm.address, amountIn);
            await expect(twamm.connect(addr1).longTermSwapFrom0To1(amountIn, 2)).to.be.reverted;
            await token1.transfer(addr1.address, amountIn);
            await token1.connect(addr1).approve(twamm.address, amountIn);
            await expect(twamm.connect(addr1).longTermSwapFrom0To1(amountIn, 2)).to.be.reverted;

            // cancel should work
            await twamm.connect(addr1).withdrawProceedsFromLongTermSwap(0)
            // await expect(twamm.connect(addr1).cancelLongTermSwap(0)).to.be.not.reverted;
            await twamm.connect(addr1).withdrawProceedsFromLongTermSwap(1)
            // await expect(twamm.connect(addr1).withdrawProceedsFromLongTermSwap(1)).to.be.not.reverted;

        });

        it("execVirtualOrders valid timestamp", async function () {

            await factory.createPair(token0.address, token1.address);
            const pairAddress = await factory.getPair(token0.address, token1.address);
            twamm = new ethers.Contract(pairAddress, UniV2TWAMMPair.abi).connect(owner);

            await token0.transfer(twamm.address, initialLiquidityProvided);
            await token1.transfer(twamm.address, initialLiquidityProvided);
            await twamm.mint(owner.address);
        });
    });

});

const allTwammTests = (multiplier) => describe(`TWAMM - swap multiplier: ${multiplier} longterm swap ratio: ${outputRatio(expandTo18Decimals(10 * multiplier), initialLiquidityProvided)}`, function () {

    let token0;
    let token1;
    let pair;
    let router;

    let twamm;

    let owner;
    let addr1;
    let addr2;
    let addr3;
    let addrs;

    let orderTimeInterval = 3600;

    describe("TWAMM Functionality ", function () {

        beforeEach(async function () {

            [owner, addr1, addr2, addr3, ...addrs] = await ethers.getSigners();

            let setupCnt = await setupContracts(true);
            token0 = setupCnt.token0;
            token1 = setupCnt.token1;
            factory = setupCnt.factory;
            twamm = setupCnt.pair;
            router = setupCnt.router;

            const [
                token0Rate,
                token1Rate,
                lastVirtualOrderTimestamp,
                _orderTimeInterval,
                rewardFactorPool0,
                rewardFactorPool1
            ] = await twamm.getTwammState()

            orderTimeInterval = _orderTimeInterval;

            token0.approve(twamm.address, ERC20Supply);
            token1.approve(twamm.address, ERC20Supply);

            //provide initial liquidity
            await token0.transfer(twamm.address, initialLiquidityProvided);
            await token1.transfer(twamm.address, initialLiquidityProvided);
            await twamm.mint(owner.address);

            // Give addr3 some token0 and token1
            await token0.transfer(addr3.address, initialAddr3Token0);
            await token1.transfer(addr3.address, initialAddr3Token1);
            // const addr3_token0_initial = await token0.balanceOf(addr3.address);
            // const addr3_token1_initial = await token1.balanceOf(addr3.address);
            // console.log(chalk.blue("addr3_token0_initial: ", (addr3_token0_initial.div(BIG18))));
            // console.log(chalk.blue("addr3_token1_initial: ", (addr3_token1_initial.div(BIG18))));
        });

        describe("Twamm execution frequency", function () {
            it("high frequency", async function () {

                const amountIn = expandTo18Decimals(10 * multiplier);
                await token0.transfer(addr1.address, amountIn.mul(2));
                await token0.connect(addr1).approve(twamm.address, amountIn.mul(2));
                await token1.transfer(addr1.address, amountIn.mul(2));
                await token1.connect(addr1).approve(twamm.address, amountIn.mul(2));

                //trigger long term order
                await transactionInSingleBlock(async () => {
                    await twamm.connect(addr1).longTermSwapFrom0To1(amountIn, 100);
                });

                // save the twammState here
                const twammState = await twammStateSnapshot(twamm)

                //move blocks forward, and execute virtual orders every time interval
                for (let i = 0; i <= 101; i++) {
                    await mineTimeIntervals(1);
                    await twamm.executeVirtualOrders(await getBlockTimestamp());
                }

                const beforeBalance0 = await token0.balanceOf(addr1.address);
                const beforeBalance1 = await token1.balanceOf(addr1.address);

                //withdraw proceeds
                await transactionInSingleBlock(async () => {
                    await twamm.connect(addr1).withdrawProceedsFromLongTermSwap(0);
                });

                // use the twamm state here
                const twammResults = await executeVirtualOrdersUntilTimestamp(twamm, (await getBlockTimestamp()), twammState);

                const afterBalance0 = await token0.balanceOf(addr1.address);
                const afterBalance1 = await token1.balanceOf(addr1.address);

                // console.log(twammResults)
                // console.log(`amountIn: ${ethers.utils.formatEther(amountIn)}`)
                // console.log(`beforeBalance0: ${ethers.utils.formatEther(beforeBalance0)}`)
                // console.log(`beforeBalance1: ${ethers.utils.formatEther(beforeBalance1)}`)
                // console.log(`afterBalance0: ${ethers.utils.formatEther(afterBalance0)}`)
                // console.log(`afterBalance1: ${ethers.utils.formatEther(afterBalance1)}`)

                expect(afterBalance0.sub(beforeBalance0)).to.be.closeTo(twammResults[2], 2)
                expect(afterBalance1.sub(beforeBalance1)).to.be.lt(twammResults[3], 2)

                //expect swap to work as expected
                // expect(beforeBalanceA).to.be.lt(afterBalanceA);
                // expect(beforeBalanceB).to.be.gt(afterBalanceB);
            });

            it("low frequency", async function () {

                const amountIn = expandTo18Decimals(10 * multiplier);
                await token0.transfer(addr1.address, amountIn.mul(2));
                await token0.connect(addr1).approve(twamm.address, amountIn.mul(2));
                await token1.transfer(addr1.address, amountIn.mul(2));
                await token1.connect(addr1).approve(twamm.address, amountIn.mul(2));

                //trigger long term order
                await transactionInSingleBlock(async () => {
                    await twamm.connect(addr1).longTermSwapFrom0To1(amountIn, 100);
                });

                // save the twammState here
                const twammState = await twammStateSnapshot(twamm)

                //move blocks forward, and execute virtual orders
                await mineTimeIntervals(101)

                const beforeBalance0 = await token0.balanceOf(addr1.address);
                const beforeBalance1 = await token1.balanceOf(addr1.address);

                //withdraw proceeds
                await transactionInSingleBlock(async () => {
                    await twamm.connect(addr1).withdrawProceedsFromLongTermSwap(0);
                });

                // use the twamm state here
                const twammResults = await executeVirtualOrdersUntilTimestamp(twamm, (await getBlockTimestamp()), twammState);

                const afterBalance0 = await token0.balanceOf(addr1.address);
                const afterBalance1 = await token1.balanceOf(addr1.address);

                // console.log(twammResults)
                // console.log(`amountIn: ${ethers.utils.formatEther(amountIn)}`)
                // console.log(`beforeBalance0: ${ethers.utils.formatEther(beforeBalance0)}`)
                // console.log(`beforeBalance1: ${ethers.utils.formatEther(beforeBalance1)}`)
                // console.log(`afterBalance0: ${ethers.utils.formatEther(afterBalance0)}`)
                // console.log(`afterBalance1: ${ethers.utils.formatEther(afterBalance1)}`)

                expect(afterBalance0.sub(beforeBalance0)).to.be.closeTo(twammResults[2], 2)
                expect(afterBalance1.sub(beforeBalance1)).to.be.closeTo(twammResults[3], 2)

                //expect swap to work as expected
                // expect(beforeBalanceA).to.be.lt(afterBalanceA);
                // expect(beforeBalanceB).to.be.gt(afterBalanceB);
            });
        });

        describe("Long term swaps", function () {

            it("Single sided long term order behaves like normal swap", async function () {

                const amountIn0 = expandTo18Decimals(10 * multiplier);
                await token0.transfer(addr1.address, amountIn0);

                const amountIn0MinusFee = amountIn0.mul(997).div(1000)

                //expected output
                let token0Reserve, token1Reserve, blockTimestampLast, twammReserve0, twammReserve1;
                [token0Reserve, token1Reserve, blockTimestampLast, twammReserve0, twammReserve1] = await twamm.getTwammReserves();
                const expectedOut =
                    token1Reserve
                        .mul(amountIn0MinusFee)
                        .div(token0Reserve.add(amountIn0MinusFee));

                //trigger long term order
                await token0.connect(addr1).approve(twamm.address, amountIn0);
                await twamm.connect(addr1).longTermSwapFrom0To1(amountIn0, 2)


                //move blocks forward, and execute virtual orders
                const timeIntervalsToMoveForward = 3;
                await mineTimeIntervals(timeIntervalsToMoveForward);
                const newBlockTimestamp = await getBlockTimestamp();

                // get the amounts from the view
                const [
                    _reserve0,
                    _reserve1,
                    _lastVirtualOrderTimestamp,
                    _twammReserve0,
                    _twammReserve1
                ] = await twamm.getReserveAfterTwamm(newBlockTimestamp);

                await twamm.connect(addr1).executeVirtualOrders(newBlockTimestamp);

                [token0Reserve, token1Reserve, blockTimestampLast, twammReserve0, twammReserve1] = await twamm.getTwammReserves();

                // console.log(`token0Reserve: ${token0Reserve}`);
                // console.log(`token1Reserve: ${token1Reserve}`);
                // console.log(`blockTimestamp: ${await getBlockTimestamp()}`);
                // console.log(`twammReserve0: ${twammReserve0}`);
                // console.log(`twammReserve1: ${twammReserve1}`);
                //
                // console.log(`_reserve0: ${_reserve0}`);
                // console.log(`_reserve1: ${_reserve1}`);
                // console.log(`_lastVirtualOrderTimestamp: ${_lastVirtualOrderTimestamp}`);
                // console.log(`_twammReserve0: ${_twammReserve0}`);
                // console.log(`_twammReserve1: ${_twammReserve1}`);

                // current block timestamp should be atleast timeIntervalsToMoveForward
                expect(await getBlockTimestamp()).to.be.gte((parseInt(_lastVirtualOrderTimestamp) + (timeIntervalsToMoveForward * orderTimeInterval)));

                expect(token0Reserve).to.be.eq(_reserve0)
                expect(token1Reserve).to.be.eq(_reserve1)
                expect(twammReserve0).to.be.eq(_twammReserve0)
                expect(twammReserve1).to.be.eq(_twammReserve1)

                //withdraw proceeds
                const beforeBalanceB = await token1.balanceOf(addr1.address);
                await twamm.connect(addr1).withdrawProceedsFromLongTermSwap(0);
                const afterBalanceB = await token1.balanceOf(addr1.address);
                const actualOutput = afterBalanceB.sub(beforeBalanceB);

                //since we are breaking up order, match is not exact
                expect(actualOutput).to.be.closeTo(expectedOut, amountIn0.mul(1).div(10000000));

            });

            it("Single sided long term submitted amount too small", async function () {

                const amountIn0 = bigNumberify(15);
                const amountIn0MinusFee = amountIn0.mul(997).div(1000)
                await token0.transfer(addr1.address, amountIn0);

                //trigger long term order
                await token0.connect(addr1).approve(twamm.address, amountIn0);
                await expect(twamm.connect(addr1).longTermSwapFrom0To1(amountIn0, 20000)).to.be.reverted;
            });

            it("Orders in both pools work as expected", async function () {

                const amountIn = expandTo18Decimals(10 * multiplier);
                await token0.transfer(addr1.address, amountIn);
                await token1.transfer(addr2.address, amountIn);

                //trigger long term order
                await token0.connect(addr1).approve(twamm.address, amountIn);
                await token1.connect(addr2).approve(twamm.address, amountIn);

                //trigger long term orders
                await twamm.connect(addr1).longTermSwapFrom0To1(amountIn, 2);
                await twamm.connect(addr2).longTermSwapFrom1To0(amountIn, 2);

                // Try to skim token0 and token1 after initiating the TWAMM swap
                const addr3_token0_before = await token0.balanceOf(addr3.address);
                const addr3_token1_before = await token1.balanceOf(addr3.address);
                await twamm.connect(addr3).skim(addr3.address);
                const addr3_token0_after = await token0.balanceOf(addr3.address);
                const addr3_token1_after = await token1.balanceOf(addr3.address);
                expect(addr3_token0_before).to.equal(addr3_token0_after);
                expect(addr3_token1_before).to.equal(addr3_token1_after);

                // Try to mint LP after initiating the TWAMM swap
                const addr3_lp_bal_before = await twamm.balanceOf(addr3.address);
                await expect(twamm.connect(addr3).mint(addr3.address)).to.be.reverted;
                const addr3_lp_bal_after = await twamm.balanceOf(addr3.address);
                expect(addr3_lp_bal_before).to.equal(addr3_lp_bal_after);

                //move blocks forward, and execute virtual orders
                await mineTimeIntervals(3)

                //withdraw proceeds
                await twamm.connect(addr1).withdrawProceedsFromLongTermSwap(0);
                await twamm.connect(addr2).withdrawProceedsFromLongTermSwap(1);

                const amountToken0Bought = await token0.balanceOf(addr2.address);
                const amountToken1Bought = await token1.balanceOf(addr1.address);

                //pool is balanced, and both orders execute same amount in opposite directions,
                //so we expect final balances to be roughly equal
                //including the fee
                expect(amountToken0Bought.add(amountToken1Bought).div(2)).to.be.closeTo(amountIn, amountIn.mul(998).div(1000))
            });

            it("Swap amounts are consistent with twamm formula", async function () {

                const token0In = expandTo18Decimals(10 * multiplier);
                const token1In = expandTo18Decimals(2 * multiplier);

                await token0.transfer(addr1.address, token0In);
                await token1.transfer(addr2.address, token1In);
                await token0.connect(addr1).approve(twamm.address, token0In);
                await token1.connect(addr2).approve(twamm.address, token1In);

                let token0ReserveRet, token1ReserveRet;
                [token0ReserveRet, token1ReserveRet] = await twamm.getReserves();

                const [
                    finalAReserveExpectedBN,
                    finalBReserveExpectedBN,
                    token0OutBN,
                    token1OutBN
                ] = calculateTwammExpectedFraxSwap(token0In, token1In, token0ReserveRet, token1ReserveRet, 10)

                //trigger long term orders
                await transactionInSingleBlock(async () => {
                    await twamm.connect(addr1).longTermSwapFrom0To1(token0In, 10);
                    await twamm.connect(addr2).longTermSwapFrom1To0(token1In, 10);
                })

                let token0ReserveRet_2, token1ReserveRet_2;
                [token0ReserveRet_2, token1ReserveRet_2] = await twamm.getReserves();
                const lp_supply = await twamm.totalSupply();
                const lp_price = ((token0ReserveRet_2.add(token1ReserveRet_2)).div(lp_supply)); // Assumes $1 each token
                // console.log("lp_supply: ", (lp_supply.div(BIG18)));
                // console.log("lp_price: ", lp_price);

                // Try to burn LP and extract token0 and token1 as a profit
                const owner_token0_before = await token0.balanceOf(owner.address);
                const owner_token1_before = await token1.balanceOf(owner.address);
                const owner_lp_bal_before = await twamm.balanceOf(owner.address);
                const owner_lp_bal_to_use = owner_lp_bal_before.div(1000); // Only will transfer a small sample
                // console.log("owner_token0_before: ", (owner_token0_before.div(BIG18)));
                // console.log("owner_token1_before: ", (owner_token1_before.div(BIG18)));
                // console.log("owner_lp_bal_before: ", (owner_lp_bal_before.div(BIG18)));
                await twamm.connect(owner).transfer(twamm.address, owner_lp_bal_to_use);
                await twamm.connect(owner).burn(owner.address);
                const owner_token0_after = await token0.balanceOf(owner.address);
                const owner_token1_after = await token1.balanceOf(owner.address);
                const owner_lp_bal_after = await twamm.balanceOf(owner.address);
                const owner_token0_diff = owner_token0_after.sub(owner_token0_before);
                const owner_token1_diff = owner_token1_after.sub(owner_token1_before);
                const owner_lp_diff = owner_lp_bal_after.sub(owner_lp_bal_before);
                // console.log("owner_token0_after: ", (owner_token0_after.div(BIG18)));
                // console.log("owner_token1_after: ", (owner_token1_after.div(BIG18)));
                // console.log("owner_lp_bal_after: ", (owner_lp_bal_after.div(BIG18)));
                // console.log("owner_token0_diff: ", owner_token0_diff.div(BIG18));
                // console.log("owner_token1_diff: ", owner_token1_diff.div(BIG18));
                // console.log("owner_lp_bal_diff: ", owner_lp_diff.div(BIG18));
                const lp_diff_value = owner_lp_diff.mul(lp_price).mul(-1).div(BIG18).toNumber();
                expect((owner_token0_diff.add(owner_token1_diff)).div(BIG18).toNumber()).to.be.closeTo(lp_diff_value, lp_diff_value / 100);

                //move blocks forward, and execute virtual orders
                await mineTimeIntervals(22)

                //withdraw proceeds
                await twamm.connect(addr1).withdrawProceedsFromLongTermSwap(0);
                await twamm.connect(addr2).withdrawProceedsFromLongTermSwap(1);

                //make sure the order was marked as completed
                const addr1_det_orders_order0 = await twamm.connect(addr1).getDetailedOrdersForUser(addr1.address, 0, 1);
                // console.log("====== Address 1 [Order 0] ======");
                // console.log(util.inspect(addr1_det_orders_order0, false, null, true));
                expect(addr1_det_orders_order0[0].isComplete).to.be.eq(true);

                const amountToken0Bought = await token0.balanceOf(addr2.address);
                const amountToken1Bought = await token1.balanceOf(addr1.address);

                let [finalAReserveActual, finalBReserveActual] = await twamm.getReserves();

                const finalAReserveActualBN = bigNumberify(finalAReserveActual.toString());
                const finalBReserveActualBN = bigNumberify(finalBReserveActual.toString());

                // console.log(`finalAReserveActualBN: ${ethers.utils.formatEther(finalAReserveActualBN)}`)
                // console.log(`finalAReserveExpectedBN: ${ethers.utils.formatEther(finalAReserveExpectedBN)}`)
                // console.log(`finalBReserveActualBN: ${ethers.utils.formatEther(finalBReserveActualBN)}`)
                // console.log(`finalBReserveExpectedBN: ${ethers.utils.formatEther(finalBReserveExpectedBN)}`)
                //
                // console.log(`amountToken0Bought: ${ethers.utils.formatEther(amountToken0Bought)}`)
                // console.log(`token0OutBN: ${ethers.utils.formatEther(token0OutBN)}`)
                // console.log(`amountToken1Bought: ${ethers.utils.formatEther(amountToken1Bought)}`)
                // console.log(`token1OutBN: ${ethers.utils.formatEther(token1OutBN)}`)

                //expect results to be close to calculation
                expect(finalAReserveActualBN, outputErrorDiffPct(finalAReserveActualBN, finalAReserveExpectedBN)).to.be.closeTo(finalAReserveExpectedBN, finalAReserveExpectedBN.div(99));
                expect(finalBReserveActualBN, outputErrorDiffPct(finalBReserveActualBN, finalBReserveExpectedBN)).to.be.closeTo(finalBReserveExpectedBN, finalBReserveExpectedBN.div(99));

                expect(amountToken0Bought, outputErrorDiffPct(amountToken0Bought, token0OutBN)).to.be.closeTo(token0OutBN, token0OutBN.div(80));
                expect(amountToken1Bought, outputErrorDiffPct(amountToken1Bought, token1OutBN)).to.be.closeTo(token1OutBN, token1OutBN.div(80));
            });

            it("Multiple orders in both pools work as expected [normal]", async function () {

                const amountIn = expandTo18Decimals(10 * multiplier);
                await token0.transfer(addr1.address, amountIn);
                await token1.transfer(addr2.address, amountIn);

                //trigger long term order
                await token0.connect(addr1).approve(twamm.address, amountIn);
                await token1.connect(addr2).approve(twamm.address, amountIn);

                //trigger long term orders
                await transactionInSingleBlock(async () => {
                    await twamm.connect(addr1).longTermSwapFrom0To1(amountIn.div(2), 2);
                    await twamm.connect(addr2).longTermSwapFrom1To0(amountIn.div(2), 3);
                    await twamm.connect(addr1).longTermSwapFrom0To1(amountIn.div(2), 4);
                    await twamm.connect(addr2).longTermSwapFrom1To0(amountIn.div(2), 5);
                });

                //print the full order info and test the offset and limit
                const addr1_det_orders_full = await twamm.connect(addr1).getDetailedOrdersForUser(addr1.address, 0, 99999);
                const addr1_det_orders_offset = await twamm.connect(addr1).getDetailedOrdersForUser(addr1.address, 1, 99999);
                const addr1_det_orders_limit = await twamm.connect(addr1).getDetailedOrdersForUser(addr1.address, 0, 1);
                const addr1_det_orders_both = await twamm.connect(addr1).getDetailedOrdersForUser(addr1.address, 1, 1);
                // console.log("====== Address 1 [Full] ======");
                // console.log(util.inspect(addr1_det_orders_full, false, null, true));
                // console.log("====== Address 1 [Offset] ======");
                // console.log(util.inspect(addr1_det_orders_offset, false, null, true));
                // console.log("====== Address 1 [Limit] ======");
                // console.log(util.inspect(addr1_det_orders_limit, false, null, true));
                // console.log("====== Address 1 [Offset & Limit] ======");
                // console.log(util.inspect(addr1_det_orders_both, false, null, true));


                //move blocks forward, and execute virtual orders
                await mineTimeIntervals(6);

                const [
                    ammEndToken0,
                    ammEndToken1,
                    token0Out,
                    token1Out
                ] = await executeVirtualOrdersUntilTimestamp(twamm, await getBlockTimestamp())

                //withdraw proceeds
                await twamm.connect(addr1).withdrawProceedsFromLongTermSwap(0);
                await twamm.connect(addr2).withdrawProceedsFromLongTermSwap(1);
                await twamm.connect(addr1).withdrawProceedsFromLongTermSwap(2);
                await twamm.connect(addr2).withdrawProceedsFromLongTermSwap(3);

                const amountToken0Bought = await token0.balanceOf(addr2.address);
                const amountToken1Bought = await token1.balanceOf(addr1.address);

                let [finalReserve0, finalReserve1] = await twamm.getReserves();

                // console.log(`ammEndToken0  ${ammEndToken0}`);
                // console.log(`finalReserve0 ${finalReserve0}`);
                // console.log(`ammEndToken1  ${ammEndToken1}`);
                // console.log(`finalReserve1 ${finalReserve1}`);
                // console.log(`token0Out          ${token0Out}`);
                // console.log(`amountToken0Bought ${amountToken0Bought}`);
                // console.log(`token1Out          ${token1Out}`);
                // console.log(`amountToken1Bought ${amountToken1Bought}`);

                expect(ammEndToken0).to.be.closeTo(finalReserve0, 2);
                expect(ammEndToken1).to.be.closeTo(finalReserve1, 2);
                expect(token0Out).to.be.closeTo(amountToken0Bought, 2);
                expect(token1Out).to.be.closeTo(amountToken1Bought, 2);

                //pool is balanced, and orders execute same amount in opposite directions,
                //so we expect final balances to be roughly equal minus the fees

                const val1 = amountToken0Bought.add(amountToken1Bought).div(2);
                const val2 = amountIn.mul(997).div(1000)

                expect(val1,
                    outputErrorDiffPct(val1, val2)
                ).to.be.closeTo(val2, amountIn.mul(20).div(1000))

            });

            it("Multiple orders in both pools work as expected [mid-period activities]", async function () {

                const amountIn = expandTo18Decimals(10 * multiplier);
                await token0.transfer(addr1.address, amountIn);
                await token1.transfer(addr2.address, amountIn);

                //trigger long term order
                await token0.connect(addr1).approve(twamm.address, amountIn);
                await token1.connect(addr2).approve(twamm.address, amountIn);

                //trigger long term orders
                await transactionInSingleBlock(async () => {
                    await twamm.connect(addr1).longTermSwapFrom0To1(amountIn.div(2), 2);
                    await twamm.connect(addr2).longTermSwapFrom1To0(amountIn.div(2), 3);
                    await twamm.connect(addr1).longTermSwapFrom0To1(amountIn.div(2), 4);
                    await twamm.connect(addr2).longTermSwapFrom1To0(amountIn.div(2), 5);
                });

                //move blocks forward, and execute virtual orders
                await mineTimeIntervals(3);

                // Call skim and sync midway to see if anything breaks
                await twamm.connect(addr3).skim(addr3.address);
                await twamm.connect(addr3).sync();

                // Vanilla UniV2 AMM swap 0 to 1
                const token0_in_swap = initialAddr3Token0.div(10000);
                await token0.connect(addr3).approve(router.address, token0_in_swap);
                const addr3_token0_before_swap = await token0.balanceOf(addr3.address);
                const addr3_token1_before_swap = await token1.balanceOf(addr3.address);
                await router.connect(addr3).swapExactTokensForTokens(token0_in_swap, 0, [token0.address, token1.address], addr3.address, 1946337480);
                const addr3_token0_after_swap = await token0.balanceOf(addr3.address);
                const addr3_token1_after_swap = await token1.balanceOf(addr3.address);
                const addr3_token0_diff_swap = addr3_token0_after_swap.sub(addr3_token0_before_swap);
                const addr3_token1_diff_swap = addr3_token1_after_swap.sub(addr3_token1_before_swap);
                // console.log("addr3_token0_after_swap: ", (addr3_token0_after_swap.div(BIG18)));
                // console.log("addr3_token1_after_swap: ", (addr3_token1_after_swap.div(BIG18)));
                // console.log("addr3_token0_diff_swap: ", addr3_token0_diff_swap.div(BIG18));
                // console.log("addr3_token1_diff_swap: ", addr3_token1_diff_swap.div(BIG18));

                // Call skim and sync midway to see if anything breaks
                await twamm.connect(addr3).skim(addr3.address);
                await twamm.connect(addr3).sync();

                // Address 3 adds some LP
                const token0_in_lp = initialAddr3Token0.div(10);
                const token1_in_lp = initialAddr3Token1.div(10);
                await token0.connect(addr3).approve(router.address, token0_in_lp);
                await token1.connect(addr3).approve(router.address, token1_in_lp);
                const addr3_token0_before_add = await token0.balanceOf(addr3.address);
                const addr3_token1_before_add = await token1.balanceOf(addr3.address);
                const addr3_lp_bal_before_add = await twamm.balanceOf(addr3.address);
                await router.connect(addr3).addLiquidity(token0.address, token1.address, token0_in_lp, token1_in_lp, 0, 0, addr3.address, 1946337480);
                const addr3_token0_after_add = await token0.balanceOf(addr3.address);
                const addr3_token1_after_add = await token1.balanceOf(addr3.address);
                const addr3_token0_diff_add = addr3_token0_after_add.sub(addr3_token0_before_add);
                const addr3_token1_diff_add = addr3_token1_after_add.sub(addr3_token1_before_add);
                const addr3_lp_bal_after_add = await twamm.balanceOf(addr3.address);
                const addr3_lp_diff_add = addr3_lp_bal_after_add.sub(addr3_lp_bal_before_add);
                // console.log("addr3_token0_after_add: ", (addr3_token0_after_add.div(BIG18)));
                // console.log("addr3_token1_after_add: ", (addr3_token1_after_add.div(BIG18)));
                // console.log("addr3_token0_diff_add: ", addr3_token0_diff_add.div(BIG18));
                // console.log("addr3_token1_diff_add: ", addr3_token1_diff_add.div(BIG18));
                // console.log("addr3_lp_diff_add: ", addr3_lp_diff_add.div(BIG18));

                //move blocks forward, and execute virtual orders
                await mineTimeIntervals(2);

                // Remove some LP
                const lp_remove_amt = addr3_lp_diff_add.div(3);
                await twamm.connect(addr3).approve(router.address, lp_remove_amt);
                const addr3_token0_before_rem = await token0.balanceOf(addr3.address);
                const addr3_token1_before_rem = await token1.balanceOf(addr3.address);
                const addr3_lp_bal_before_rem = await twamm.balanceOf(addr3.address);
                await router.connect(addr3).removeLiquidity(token0.address, token1.address, lp_remove_amt, 0, 0, addr3.address, 1946337480);
                const addr3_token0_after_rem = await token0.balanceOf(addr3.address);
                const addr3_token1_after_rem = await token1.balanceOf(addr3.address);
                const addr3_token0_diff_rem = addr3_token0_after_rem.sub(addr3_token0_before_rem);
                const addr3_token1_diff_rem = addr3_token1_after_rem.sub(addr3_token1_before_rem);
                const addr3_lp_bal_after_rem = await twamm.balanceOf(addr3.address);
                const addr3_lp_diff_rem = addr3_lp_bal_after_rem.sub(addr3_lp_bal_before_rem);
                // console.log("addr3_token0_after_rem: ", (addr3_token0_after_rem.div(BIG18)));
                // console.log("addr3_token1_after_rem: ", (addr3_token1_after_rem.div(BIG18)));
                // console.log("addr3_token0_diff_rem: ", addr3_token0_diff_rem.div(BIG18));
                // console.log("addr3_token1_diff_rem: ", addr3_token1_diff_rem.div(BIG18));
                // console.log("addr3_lp_diff_rem: ", addr3_lp_diff_rem.div(BIG18));

                await mineTimeIntervals(1);

                //withdraw proceeds
                await twamm.connect(addr1).withdrawProceedsFromLongTermSwap(0);
                await twamm.connect(addr2).withdrawProceedsFromLongTermSwap(1);
                await twamm.connect(addr1).withdrawProceedsFromLongTermSwap(2);
                await twamm.connect(addr2).withdrawProceedsFromLongTermSwap(3);

                const amountToken0Bought = await token0.balanceOf(addr2.address);
                const amountToken1Bought = await token1.balanceOf(addr1.address);

                //pool is balanced, and orders execute same amount in opposite directions,
                //so we expect final balances to be roughly equal minus the fees

                const val1 = amountToken0Bought.add(amountToken1Bought).div(2);
                const val2 = amountIn.mul(997).div(1000)

                expect(val1,
                    outputErrorDiffPct(val1, val2)
                ).to.be.closeTo(val2, amountIn.mul(20).div(1000))
            });

            it("Normal swap works as expected while long term orders are active", async function () {

                const amountIn = expandTo18Decimals(20 * multiplier);
                await token0.transfer(addr1.address, amountIn);
                await token1.transfer(addr2.address, amountIn);

                //trigger long term order
                await token0.connect(addr1).approve(twamm.address, amountIn);
                await token1.connect(addr2).approve(twamm.address, amountIn);

                //trigger long term orders
                await transactionInSingleBlock(async () => {
                    await twamm.connect(addr1).longTermSwapFrom0To1(amountIn, 10);
                    await twamm.connect(addr2).longTermSwapFrom1To0(amountIn, 10);
                });

                //move blocks forward, and execute virtual orders
                await mineTimeIntervals(3)

                await transactionInSingleBlock(async () => {
                    await twamm.connect(addr1).withdrawProceedsFromLongTermSwap(0);
                    await twamm.connect(addr2).withdrawProceedsFromLongTermSwap(1);
                });

                const amountToken0Bought = await token0.balanceOf(addr2.address);
                const amountToken1Bought = await token1.balanceOf(addr1.address);

                //pool is balanced, and both orders execute same amount in opposite directions,
                //so we expect final balances to be roughly equal
                expect(amountToken0Bought, outputErrorDiffPct(amountToken0Bought, amountToken1Bought)).to.be.closeTo(amountToken1Bought, amountIn.div(80))
            });
        });

        describe("Cancelling orders", function () {

            it("Order can be cancelled", async function () {

                const amountIn = expandTo18Decimals(10 * multiplier);
                await token0.transfer(addr1.address, amountIn);
                await token0.connect(addr1).approve(twamm.address, amountIn);

                const amountToken0Before = await token0.balanceOf(addr1.address);
                const amountToken1Before = await token1.balanceOf(addr1.address);

                //trigger long term order
                await twamm.connect(addr1).longTermSwapFrom0To1(amountIn, 10);

                //move blocks forward, and execute virtual orders
                await mineTimeIntervals(3)
                await twamm.connect(addr1).cancelLongTermSwap(0);

                //make sure the order was marked as completed
                const addr1_det_orders_order0 = await twamm.connect(addr1).getDetailedOrdersForUser(addr1.address, 0, 1);
                // console.log("====== Address 1 [Order 0] ======");
                // console.log(util.inspect(addr1_det_orders_order0, false, null, true));
                expect(addr1_det_orders_order0[0].isComplete).to.be.eq(true);

                const amountToken0After = await token0.balanceOf(addr1.address);
                const amountToken1After = await token1.balanceOf(addr1.address);

                //expect some amount of the order to be filled
                expect(amountToken0Before).to.be.gt(amountToken0After);
                expect(amountToken1Before).to.be.lt(amountToken1After);
            });

        });

        describe("Partial withdrawal", function () {

            it("proceeds can be withdrawn while order is still active", async function () {

                const amountIn = expandTo18Decimals(10 * multiplier);
                await token0.transfer(addr1.address, amountIn);
                await token0.connect(addr1).approve(twamm.address, amountIn);

                await token1.transfer(addr2.address, amountIn);
                await token1.connect(addr2).approve(twamm.address, amountIn);

                //trigger long term order
                await twamm.connect(addr1).longTermSwapFrom0To1(amountIn, 10);

                //move blocks forward, and execute virtual orders
                await mineTimeIntervals(3)

                const amountInWithFee = bigNumberify(amountIn).mul(997).div(1000);
                const numerator = amountInWithFee.mul(100029189);
                const denominator = bigNumberify(99971010).add(amountInWithFee);
                const amountOut = numerator.div(denominator);

                const beforeBalanceA = await token0.balanceOf(addr2.address);
                const beforeBalanceB = await token1.balanceOf(addr2.address);
                await token1.connect(addr2).transfer(twamm.address, amountIn);
                await (await twamm.connect(addr2).swap(amountOut, 0, addr2.address, '0x')).wait();
                const afterBalanceA = await token0.balanceOf(addr2.address);
                const afterBalanceB = await token1.balanceOf(addr2.address);

                //expect swap to work as expected
                expect(beforeBalanceA).to.be.lt(afterBalanceA);
                expect(beforeBalanceB).to.be.gt(afterBalanceB);
            });

        });

    });
});

describe("Multiple TWAMM Tests", function () {
    runOnce()
    allTwammTests(1)
    allTwammTests(10)
    allTwammTests(100)
    allTwammTests(1000)
    allTwammTests(2000)
    allTwammTests(3000)
    allTwammTests(4000)
    allTwammTests(5000)
    allTwammTests(6000)
    allTwammTests(7000)
    allTwammTests(8000)
    allTwammTests(9000)
})

async function mineBlocks(blockNumber) {
    for (let i = 0; i < blockNumber; i++) {
        await network.provider.send("evm_mine")
    }
}

async function mineTimeIntervals(timeIntervals) {

    // use this when it's ready from hardhat: https://github.com/NomicFoundation/hardhat/issues/1998#issuecomment-1046824743
    // await network.provider.send("hardhat_mine", [timeIntervals, 3600])

    let currTime = await getBlockTimestamp();
    const targetTime = currTime + (orderTimeInterval * timeIntervals);
    // mine blocks until targetTime is reached
    while (currTime <= targetTime) {
        // mine blocks as half orderTimeInterval
        await network.provider.send("evm_increaseTime", [parseInt(`${orderTimeInterval / 2}`)]);
        await network.provider.send("evm_mine");
        currTime = await getBlockTimestamp();
    }
}
