/* global artifacts:false, it:false, contract:false, assert:false */

const StaticMarket = artifacts.require("StaticMarket");
const WyvernAtomicizer = artifacts.require("WyvernAtomicizer");
const WyvernExchange = artifacts.require("WyvernExchange");
const WyvernRegistry = artifacts.require("WyvernRegistry");
const WyvernStatic = artifacts.require("WyvernStatic");
const TestERC20 = artifacts.require("TestERC20");
const TestERC721 = artifacts.require("TestERC721");

const Web3 = require("web3");
const provider = new Web3.providers.HttpProvider("http://localhost:8545");
const web3 = new Web3(provider);

const { CHAIN_ID, ZERO_BYTES32, wrap } = require("./aux");

contract("WyvernExchange", (accounts) => {
  const deployCoreContracts = async () => {
    const [registry, atomicizer] = await Promise.all([
      WyvernRegistry.new(),
      WyvernAtomicizer.new(),
    ]);
    const [exchange, statici, staticMarket] = await Promise.all([
      WyvernExchange.new(CHAIN_ID, [registry.address], "0x"),
      WyvernStatic.new(atomicizer.address),
      StaticMarket.new(),
    ]);
    await registry.grantInitialAuthentication(exchange.address);
    return {
      registry,
      exchange: wrap(exchange),
      atomicizer,
      statici,
      staticMarket,
    };
  };

  const deploy = async (contracts) =>
    Promise.all(contracts.map((contract) => contract.new()));

  it("erc721 <> erc20 + fees without any checks", async () => {
    const alice = accounts[0];
    const bob = accounts[1];
    const carol = accounts[2];
    const david = accounts[3];

    const { atomicizer, exchange, registry, statici, staticMarket } =
      await deployCoreContracts();
    const [erc20, erc721] = await deploy([TestERC20, TestERC721]);

    const abi = [
      {
        constant: false,
        inputs: [
          { name: "addrs", type: "address[]" },
          { name: "values", type: "uint256[]" },
          { name: "calldataLengths", type: "uint256[]" },
          { name: "calldatas", type: "bytes" },
        ],
        name: "atomicize",
        outputs: [],
        payable: false,
        stateMutability: "nonpayable",
        type: "function",
      },
    ];
    const atomicizerc = new web3.eth.Contract(abi, atomicizer.address);

    await registry.registerProxy({ from: alice });
    const aliceProxy = await registry.proxies(alice);
    assert.equal(true, aliceProxy.length > 0, "No proxy address for Alice");

    await registry.registerProxy({ from: bob });
    const bobProxy = await registry.proxies(bob);
    assert.equal(true, bobProxy.length > 0, "No proxy address for Bob");

    const amount = 1000;
    const fee1 = 10;
    const fee2 = 20;
    const tokenId = 0;

    await Promise.all([
      erc20.mint(bob, amount + fee1 + fee2),
      erc721.mint(alice, tokenId),
    ]);

    await Promise.all([
      erc20.approve(bobProxy, amount + fee1 + fee2, { from: bob }),
      erc721.setApprovalForAll(aliceProxy, true, { from: alice }),
    ]);

    const erc20c = new web3.eth.Contract(erc20.abi, erc20.address);
    const erc721c = new web3.eth.Contract(erc721.abi, erc721.address);

    const selector = web3.eth.abi.encodeFunctionSignature(
      "split(bytes,address[7],uint8[2],uint256[6],bytes,bytes)"
    );
    // Call can be anything
    const selectorCall = web3.eth.abi.encodeFunctionSignature(
      "anySingle(bytes,address[7],uint8,uint256[6],bytes)"
    );
    // Countercall can be anything
    const selectorCountercall = web3.eth.abi.encodeFunctionSignature(
      "anySingle(bytes,address[7],uint8,uint256[6],bytes)"
    );

    const params = web3.eth.abi.encodeParameters(
      ["address[2]", "bytes4[2]", "bytes", "bytes"],
      [
        [statici.address, statici.address],
        [selectorCall, selectorCountercall],
        "0x",
        "0x",
      ]
    );

    const one = {
      registry: registry.address,
      maker: alice,
      staticTarget: statici.address,
      staticSelector: selector,
      staticExtradata: params,
      maximumFill: 1,
      listingTime: "0",
      expirationTime: "10000000000",
      salt: "11",
    };
    const sigOne = await exchange.sign(one, alice);

    const two = {
      registry: registry.address,
      maker: bob,
      staticTarget: statici.address,
      staticSelector: selector,
      staticExtradata: params,
      maximumFill: amount,
      listingTime: "0",
      expirationTime: "10000000000",
      salt: "12",
    };
    const sigTwo = await exchange.sign(two, bob);

    const firstData = erc721c.methods
      .transferFrom(alice, bob, tokenId)
      .encodeABI();

    const c1 = erc20c.methods.transferFrom(bob, alice, amount).encodeABI();
    const c2 = erc20c.methods.transferFrom(bob, carol, fee1).encodeABI();
    const c3 = erc20c.methods.transferFrom(bob, david, fee2).encodeABI();
    const secondData = atomicizerc.methods
      .atomicize(
        [erc20.address, erc20.address, erc20.address],
        [0, 0, 0],
        [(c1.length - 2) / 2, (c2.length - 2) / 2, (c3.length - 2) / 2],
        c1 + c2.slice("2") + c3.slice("2")
      )
      .encodeABI();

    const firstCall = { target: erc721.address, howToCall: 0, data: firstData };
    const secondCall = {
      target: atomicizer.address,
      howToCall: 1,
      data: secondData,
    };

    await exchange.atomicMatchWith(
      one,
      sigOne,
      firstCall,
      two,
      sigTwo,
      secondCall,
      ZERO_BYTES32,
      { from: carol }
    );

    const [
      aliceErc20Balance,
      carolErc20Balance,
      davidErc20Balance,
      tokenIdOwner,
    ] = await Promise.all([
      erc20.balanceOf(alice),
      erc20.balanceOf(carol),
      erc20.balanceOf(david),
      erc721.ownerOf(tokenId),
    ]);
    assert.equal(
      aliceErc20Balance.toNumber(),
      amount,
      "Incorrect ERC20 balance"
    );
    assert.equal(carolErc20Balance.toNumber(), fee1, "Incorrect ERC20 balance");
    assert.equal(davidErc20Balance.toNumber(), fee2, "Incorrect ERC20 balance");
    assert.equal(tokenIdOwner, bob, "Incorrect token owner");
  });

  it("erc721 <> erc20 + fees with checks", async () => {
    const alice = accounts[0];
    const bob = accounts[1];
    const carol = accounts[2];
    const david = accounts[3];

    const { atomicizer, exchange, registry, statici } =
      await deployCoreContracts();
    const [erc20, erc721] = await deploy([TestERC20, TestERC721]);

    const abi = [
      {
        constant: false,
        inputs: [
          { name: "addrs", type: "address[]" },
          { name: "values", type: "uint256[]" },
          { name: "calldataLengths", type: "uint256[]" },
          { name: "calldatas", type: "bytes" },
        ],
        name: "atomicize",
        outputs: [],
        payable: false,
        stateMutability: "nonpayable",
        type: "function",
      },
    ];
    const atomicizerc = new web3.eth.Contract(abi, atomicizer.address);

    await registry.registerProxy({ from: alice });
    const aliceProxy = await registry.proxies(alice);
    assert.equal(true, aliceProxy.length > 0, "No proxy address for Alice");

    await registry.registerProxy({ from: bob });
    const bobProxy = await registry.proxies(bob);
    assert.equal(true, bobProxy.length > 0, "No proxy address for Bob");

    const amount = 1000;
    const fee1 = 10;
    const fee2 = 20;
    const tokenId = 0;

    await Promise.all([
      erc20.mint(bob, amount + fee1 + fee2),
      erc721.mint(alice, tokenId),
    ]);

    await Promise.all([
      erc20.approve(bobProxy, amount + fee1 + fee2, { from: bob }),
      erc721.setApprovalForAll(aliceProxy, true, { from: alice }),
    ]);

    const erc20c = new web3.eth.Contract(erc20.abi, erc20.address);
    const erc721c = new web3.eth.Contract(erc721.abi, erc721.address);

    let selectorOne, extradataOne;
    {
      const selector = web3.eth.abi.encodeFunctionSignature(
        "split(bytes,address[7],uint8[2],uint256[6],bytes,bytes)"
      );
      // Call should be an ERC721 transfer
      const selectorCall = web3.eth.abi.encodeFunctionSignature(
        "transferERC721Exact(bytes,address[7],uint8,uint256[6],bytes)"
      );
      const extradataCall = web3.eth.abi.encodeParameters(
        ["address", "uint256"],
        [erc721.address, tokenId]
      );
      // Countercall should include an ERC20 transfer
      const selectorCountercall = web3.eth.abi.encodeFunctionSignature(
        "sequenceAnyAfter(bytes,address[7],uint8,uint256[6],bytes)"
      );
      const countercallSelector1 = web3.eth.abi.encodeFunctionSignature(
        "transferERC20Exact(bytes,address[7],uint8,uint256[6],bytes)"
      );
      const countercallExtradata1 = web3.eth.abi.encodeParameters(
        ["address", "uint256"],
        [erc20.address, amount]
      );
      const extradataCountercall = web3.eth.abi.encodeParameters(
        ["address[]", "uint256[]", "bytes4[]", "bytes"],
        [
          [statici.address],
          [(countercallExtradata1.length - 2) / 2],
          [countercallSelector1],
          countercallExtradata1,
        ]
      );

      const params = web3.eth.abi.encodeParameters(
        ["address[2]", "bytes4[2]", "bytes", "bytes"],
        [
          [statici.address, statici.address],
          [selectorCall, selectorCountercall],
          extradataCall,
          extradataCountercall,
        ]
      );

      selectorOne = selector;
      extradataOne = params;
    }

    const one = {
      registry: registry.address,
      maker: alice,
      staticTarget: statici.address,
      staticSelector: selectorOne,
      staticExtradata: extradataOne,
      maximumFill: 1,
      listingTime: "0",
      expirationTime: "10000000000",
      salt: "11",
    };
    const sigOne = await exchange.sign(one, alice);

    let selectorTwo, extradataTwo;
    {
      const selector = web3.eth.abi.encodeFunctionSignature(
        "split(bytes,address[7],uint8[2],uint256[6],bytes,bytes)"
      );
      // Call should be an ERC20 transfer to recipient + fees
      const selectorCall = web3.eth.abi.encodeFunctionSignature(
        "sequenceExact(bytes,address[7],uint8,uint256[6],bytes)"
      );
      const callSelector1 = web3.eth.abi.encodeFunctionSignature(
        "transferERC20Exact(bytes,address[7],uint8,uint256[6],bytes)"
      );
      const callExtradata1 = web3.eth.abi.encodeParameters(
        ["address", "uint256"],
        [erc20.address, amount]
      );
      const callSelector2 = web3.eth.abi.encodeFunctionSignature(
        "transferERC20ExactTo(bytes,address[7],uint8,uint256[6],bytes)"
      );
      const callExtradata2 = web3.eth.abi.encodeParameters(
        ["address", "uint256", "address"],
        [erc20.address, fee1, carol]
      );
      const callSelector3 = web3.eth.abi.encodeFunctionSignature(
        "transferERC20ExactTo(bytes,address[7],uint8,uint256[6],bytes)"
      );
      const callExtradata3 = web3.eth.abi.encodeParameters(
        ["address", "uint256", "address"],
        [erc20.address, fee2, david]
      );
      const extradataCall = web3.eth.abi.encodeParameters(
        ["address[]", "uint256[]", "bytes4[]", "bytes"],
        [
          [statici.address, statici.address, statici.address],
          [
            (callExtradata1.length - 2) / 2,
            (callExtradata2.length - 2) / 2,
            (callExtradata3.length - 2) / 2,
          ],
          [callSelector1, callSelector2, callSelector3],
          callExtradata1 +
            callExtradata2.slice("2") +
            callExtradata3.slice("2"),
        ]
      );
      // Countercall should be an ERC721 transfer
      const selectorCountercall = web3.eth.abi.encodeFunctionSignature(
        "transferERC721Exact(bytes,address[7],uint8,uint256[6],bytes)"
      );
      const extradataCountercall = web3.eth.abi.encodeParameters(
        ["address", "uint256"],
        [erc721.address, tokenId]
      );

      const params = web3.eth.abi.encodeParameters(
        ["address[2]", "bytes4[2]", "bytes", "bytes"],
        [
          [statici.address, statici.address],
          [selectorCall, selectorCountercall],
          extradataCall,
          extradataCountercall,
        ]
      );

      selectorTwo = selector;
      extradataTwo = params;
    }

    const two = {
      registry: registry.address,
      maker: bob,
      staticTarget: statici.address,
      staticSelector: selectorTwo,
      staticExtradata: extradataTwo,
      maximumFill: amount,
      listingTime: "0",
      expirationTime: "10000000000",
      salt: "12",
    };
    const sigTwo = await exchange.sign(two, bob);

    const firstData = erc721c.methods
      .transferFrom(alice, bob, tokenId)
      .encodeABI();

    const c1 = erc20c.methods.transferFrom(bob, alice, amount).encodeABI();
    const c2 = erc20c.methods.transferFrom(bob, carol, fee1).encodeABI();
    const c3 = erc20c.methods.transferFrom(bob, david, fee2).encodeABI();
    const secondData = atomicizerc.methods
      .atomicize(
        [erc20.address, erc20.address, erc20.address],
        [0, 0, 0],
        [(c1.length - 2) / 2, (c2.length - 2) / 2, (c3.length - 2) / 2],
        c1 + c2.slice("2") + c3.slice("2")
      )
      .encodeABI();

    const firstCall = { target: erc721.address, howToCall: 0, data: firstData };
    const secondCall = {
      target: atomicizer.address,
      howToCall: 1,
      data: secondData,
    };

    await exchange.atomicMatchWith(
      one,
      sigOne,
      firstCall,
      two,
      sigTwo,
      secondCall,
      ZERO_BYTES32,
      { from: carol }
    );

    const [
      aliceErc20Balance,
      carolErc20Balance,
      davidErc20Balance,
      tokenIdOwner,
    ] = await Promise.all([
      erc20.balanceOf(alice),
      erc20.balanceOf(carol),
      erc20.balanceOf(david),
      erc721.ownerOf(tokenId),
    ]);
    assert.equal(
      aliceErc20Balance.toNumber(),
      amount,
      "Incorrect ERC20 balance"
    );
    assert.equal(carolErc20Balance.toNumber(), fee1, "Incorrect ERC20 balance");
    assert.equal(davidErc20Balance.toNumber(), fee2, "Incorrect ERC20 balance");
    assert.equal(tokenIdOwner, bob, "Incorrect token owner");
  });
});
