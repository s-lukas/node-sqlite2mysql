#!/usr/bin/nodejs

const Sqlite3       = require('sqlite3');
const MySQL         = require('promise-mysql');
const Moment        = require('moment');
const Commander    = require('commander');
const Package       = require('./package.json');


var oSqlite3        = null;
var oMySQL          = null;
var sDB             = '';
var sPrefix         = '';


function sqlite3All ( sSQL, aParams )
{
    return new Promise( ( resolve, reject ) =>
    {
        oSqlite3.all(sSQL, aParams, ( err, aRows ) =>
        {
            if ( err )
            {
                return reject(err);
            }

            return resolve(aRows);
        });
    });
}


function getDefault ( sType, bNullable )
{
    if ( bNullable )
    {
        return null;
    }

    switch ( sType )
    {
        case 'varchar':
        case 'text':
            return '';
        default:
            return 0;
    }
}

function validateValue ( oField, sValue )
{
    if ( typeof(sValue) === 'undefined' || (sValue === null && !oField.nullable) )
    {
        return oField.default;
    }

    if ( sValue === null && oField.nullable )
    {
        return null;
    }

    switch ( oField.type )
    {
        case 'int':
            return parseInt(sValue);
        case 'float':
        case 'decimal':
            return parseFloat(sValue);
        case 'tinyint':
        case 'boolean':
            if ( sValue == 1 || sValue === true || sValue === 'true' )
            {
                return 1;
            }
            else if ( sValue == 0 || sValue === false || sValue === 'false' )
            {
                return 0;
            }
            else
            {
                return sValue ? 1 : 0;
            }
        case 'timestamp':
            return Moment.max(Moment(sValue), Moment.utc('1970-01-01 00:00:01')).local().format('YYYY-MM-DD HH:mm:ss');
        default:
            return sValue;
    }
}


async function loadMapping ( )
{
    var aSrcTables  = [];
    var aDestTables = [];
    var aConvTables = [];

    let arr = await sqlite3All("select name from sqlite_master where type='table'");

    aSrcTables  = arr.map( ( o ) => o.name );

    let rows = await oMySQL.query('SELECT table_name FROM information_schema.tables WHERE table_schema = ?', [sDB]);

    aDestTables = rows.map( ( o ) => o.table_name );

    for ( var i in aSrcTables )
    {
        var sTable  = aSrcTables[i];

        if ( aDestTables.includes(sTable) )
        {
            aConvTables.push([sTable, sTable]);
        }
        else if ( ! sTable.startsWith(sPrefix) && aDestTables.includes(sPrefix + sTable) )
        {
            aConvTables.push([sTable, sPrefix + sTable]);
        }
        else
        {
            console.error('WARNING: table \"' + sTable + '\" not found in destination');
            continue;
        }
    }

    let aResult     = [];

    for ( let aTableMap of aConvTables )
    {
        var sSrcTable   = aTableMap[0];
        var sDestTable  = aTableMap[1];

        let rows = await oMySQL.query('select column_name, data_type, column_default, character_maximum_length, is_nullable from INFORMATION_SCHEMA.COLUMNS where table_name = ? and table_schema = ?', [sDestTable, sDB]);

        var aFields     = [];

        for ( var i in rows )
        {
            var oRow        = rows[i];
            var bIsNullable = oRow.is_nullable == 'YES';

            aFields.push({'name':       oRow.column_name,
                          'nullable':   bIsNullable,
                          'type':       oRow.data_type,
                          'required':   !oRow.column_default,
                          'default':    getDefault(oRow.data_type, bIsNullable)});
        }

        aResult.push({'src_name': sSrcTable, 'dest_name': sDestTable, 'fields': aFields});
    }

    return aResult;
}


async function truncateTable ( oTable, bDryRun )
{
    if ( ! bDryRun )
    {
        await oMySQL.query('SET FOREIGN_KEY_CHECKS = 0;');
        await oMySQL.query('TRUNCATE TABLE `' + oTable.dest_name + '`');
        await oMySQL.query('SET FOREIGN_KEY_CHECKS = 1;');
    }
}


async function copyTable ( oTable, bDryRun )
{
    var aRows       = [];
    var aFields     = [];
    var sSql        = '';
    var iTotalRows  = 0;

    console.log('Copying table \"' + oTable.src_name + '\" to \"' + oTable.dest_name + '\" ...');

    let arr = await sqlite3All("select * from " + oTable.src_name);

    iTotalRows  = arr.length;

    if ( arr.length <= 0 )
    {
        return [];
    }

    var subarrays   = [];

    while ( arr.length > 0 )
    {
        subarrays.push(arr.splice(0, 100));
    }

    for ( let aSrcRows of subarrays )
    {
        var aSrcFields  = Object.keys(aSrcRows[0]);
        var iParam      = 1;

        sSql            = 'INSERT INTO `' + oTable.dest_name + '` (';
        aFields         = oTable.fields.filter( ( o ) => (aSrcFields.includes(o.name) || o.required) );

        sSql    += aFields.map( ( o ) => ('`' + o.name + '`') ).join(',');
        sSql    += ') VALUES ';

        for ( var i = 0; i < aSrcRows.length; i++ )
        {
            sSql    += ((i == 0) ? '(' : ', (');

            for ( var j = 0; j < aFields.length; j++, iParam++)
            {
                sSql += ((j == 0) ? '?' : ', ?');
            }

            sSql    += ')';
        }

        var aDestValues     = [];

        for ( var i in aSrcRows )
        {
            var oSrcRow     = aSrcRows[i];

            for ( let oField of aFields )
            {
                let mValue  = null;

                mValue  = validateValue(oField, oSrcRow[oField.name]);

                aDestValues.push(mValue);
            }
        }

        if ( ! bDryRun )
        {
            await oMySQL.query(sSql, aDestValues);
        }
    }

    console.log('Copying table \"' + oTable.src_name + '\" to \"' + oTable.dest_name + '\" ... done (' + iTotalRows + ' rows copied)');
}

var aTables = [];

async function main ( sSqliteFile, sMySQLUri, oOptions )
{
    if ( oOptions.dryRun )
    {
        console.log('** Simulating table copy - no data gets changed! **');
    }

    console.log('Copying from "' + sSqliteFile + '" to "' + sMySQLUri + '"');

    var rURI            = /^(?:(?:mysql\:)?\/{0,2})?([^:]*):([^@]*)@?([^:\/\s]+)(?::(\d*))?\/(\w+)*$/i;
    var aURIData        = sMySQLUri.match(rURI);


    var oDBLogin        = {user: aURIData[1],
                           password: aURIData[2],
                           host: aURIData[3],
                           port: parseInt(aURIData[4]) || 5432,
                           database: aURIData[5],
                           charset : oOptions.charset || 'utf8mb4'};

    oSqlite3        = new Sqlite3.Database(sSqliteFile);
    oMySQL          = null;
    sDB             = oDBLogin.database;
    sPrefix         = oOptions.prefix || '';

    oMySQL  = await MySQL.createConnection(oDBLogin);

    let arr = await loadMapping();

    for ( let obj of arr )
    {
        await truncateTable(obj, oOptions.dryRun);
        await copyTable(obj, oOptions.dryRun);
    }

    console.log('   done');

    await oMySQL.end();
}

Commander
    .version(Package.version)
    .option('-c, --charset [charset]', 'Use charset for mysql connection')
    .option('-p, --prefix [prefix]', 'Use prefix for table mapping')
    .option('-d, --dry-run', 'Simulate import, don\'t change anything')
    .arguments('<sqlite_file> <mysql_uri>')
    .action( ( sSqliteFile, sMySQLUri ) =>
    {
        main(sSqliteFile, sMySQLUri, Commander)
            .catch(console.error);
    })
    .parse(process.argv);

if ( process.argv.length <= 2 )
{
    Commander.outputHelp();
}
