import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Solspin } from "../target/types/solspin";
import { assert, expect } from "chai";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
  Connection,
} from "@solana/web3.js";
import * as sb from "@switchboard-xyz/on-demand";
import { SYSTEM_PROGRAM_ID } from "@coral-xyz/anchor/dist/cjs/native/system";
import { publicKey } from "@coral-xyz/anchor/dist/cjs/utils";


describe("solspin", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Solspin as Program<Solspin>;

  it("Admin initialized the Game Vault", async() => {
      const signer = provider.wallet.publicKey;
  const [escrowVaultPDA, bump] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("escrow_vault")],
    program.programId
  );
  
  try {
    const tx = await program.methods.initializeHouse().accounts({
      admin: signer,      
    }).rpc();
    console.log("Vault initialized:", tx);
  } catch (err) {
    if (err.toString().includes("already in use")) {
      console.log("Vault already initialized (skipping)");
    } else {
      throw err; // Re-throw if it's a different error
    }
  }

    const accountInfo = await program.provider.connection.getAccountInfo(escrowVaultPDA);
    assert.ok(accountInfo !== null);
    assert.ok(accountInfo.owner.equals(program.programId)); // Owned by your program
    assert.ok(accountInfo.data.length === 8); // Only Anchor discriminator (space=8)
    console.log("Vault successfully initialized: ", escrowVaultPDA.toBase58());

  })

  it("Player Initializing game", async() => {
    const signer = provider.wallet.publicKey;
    const [gameStatePDA, bump] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("game_state"), signer.toBuffer()],
      program.programId
    )
    try {
      const tx = await program.methods.initialize().accounts({
      signer:signer,
    }).rpc();

    console.log("Transaction:", tx);
    } catch (err) {
          if (err.toString().includes("already in use")) {
       console.log("Vault already initialized (skipping)");
    } else {
      throw err; // Re-throw if it's a different error
    }
    }

     // 1. Account exists
  const account = await program.provider.connection.getAccountInfo(gameStatePDA);
  expect(account).to.not.be.null;

  // 2. Initial values correct
  const state = await program.account.gameState.fetch(gameStatePDA);
  expect(state.wager.toNumber()).to.equal(0);
  expect(state.playerGuess).to.equal(0);
  expect(state.commitSlot.toNumber()).to.equal(0);
  expect(state.vrfAcc.toString()).to.equal(PublicKey.default.toString());
  expect(state.maxResult).to.equal(6);

  // 3. Correct PDA
  const [derivedPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("game_state"), signer.toBuffer()],
    program.programId
  );
  expect(gameStatePDA.toString()).to.equal(derivedPDA.toString());

console.log("Game state PDA:", gameStatePDA.toBase58());

  // 4. Can't init twice
  try {
    await program.methods
      .initialize()
      .accounts({
      signer:provider.wallet.publicKey,
      })
      .rpc();
    expect.fail("Should not allow double initialization");
  } catch (err) {
    expect(err.toString()).to.include("already in use");
  }
  })
})






